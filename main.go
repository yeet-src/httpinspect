// SPDX-License-Identifier: GPL-2.0
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	ethPIP   = 0x0800
	ethPIPv6 = 0x86dd
	ethPAll  = 0x0003

	dataMax = 512
	minReq  = 16
	respCap = 32

	kindRequest  = 0
	kindResponse = 1

	histLen = 60
	latLen  = 200
)

var monoStart = time.Now()

type config struct {
	iface     string
	keepQuery bool
	verify    bool
	duration  time.Duration
}

func main() {
	cfg := parseFlags()

	ifaces, ifaceLabel, err := selectInterfaces(cfg.iface)
	if err != nil {
		fatalf("[httpinspect] %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	state := newState(cfg.keepQuery)
	capture := newCapture(state)
	if err := capture.start(ctx, ifaces); err != nil {
		fatalf("[httpinspect] %v", err)
	}
	defer capture.close()

	go runSampler(ctx, state)

	if cfg.verify {
		runVerify(ctx, state, ifaces, cfg.duration)
		return
	}

	if !isCharDevice(os.Stdin) || !isCharDevice(os.Stdout) {
		fatalf("[httpinspect] needs an interactive terminal; use --verify for headless checks")
	}
	if err := runTUI(ctx, cancel, state, ifaceLabel); err != nil && !errors.Is(err, context.Canceled) {
		fatalf("[httpinspect] %v", err)
	}
}

func parseFlags() config {
	var cfg config
	flag.StringVar(&cfg.iface, "iface", "", "comma-separated interface names to watch")
	flag.BoolVar(&cfg.keepQuery, "keep-query", false, "keep query strings distinct")
	flag.BoolVar(&cfg.verify, "verify", false, "headless capture sanity check")
	flag.DurationVar(&cfg.duration, "duration", 4500*time.Millisecond, "duration for --verify")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "Usage:\n")
		fmt.Fprintf(flag.CommandLine.Output(), "  httpinspect [--iface lo,eth0] [--keep-query]\n")
		fmt.Fprintf(flag.CommandLine.Output(), "  httpinspect --verify [--duration 4.5s] [--iface lo]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	return cfg
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func selectInterfaces(csv string) ([]net.Interface, string, error) {
	all, err := net.Interfaces()
	if err != nil {
		return nil, "", fmt.Errorf("could not list interfaces: %w", err)
	}

	var wanted map[string]bool
	if strings.TrimSpace(csv) != "" {
		wanted = map[string]bool{}
		for _, part := range strings.Split(csv, ",") {
			name := strings.TrimSpace(part)
			if name != "" {
				wanted[name] = true
			}
		}
	}

	var out []net.Interface
	for _, iface := range all {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if wanted != nil && !wanted[iface.Name] {
			continue
		}
		out = append(out, iface)
	}
	if len(out) == 0 {
		return nil, "", fmt.Errorf("no matching up interfaces to watch")
	}

	if wanted != nil {
		names := make([]string, 0, len(out))
		for _, iface := range out {
			names = append(names, iface.Name)
		}
		return out, strings.Join(names, ","), nil
	}
	return out, fmt.Sprintf("all (%d)", len(out)), nil
}

/* ---- capture ------------------------------------------------------ */

type event struct {
	ts       int64
	sport    uint16
	dport    uint16
	seq      uint32
	family   uint8
	kind     uint8
	totalLen uint32
	data     []byte
}

type capture struct {
	state *State
	fds   []int
	wg    sync.WaitGroup
	once  sync.Once
}

func newCapture(state *State) *capture { return &capture{state: state} }

func (c *capture) start(ctx context.Context, ifaces []net.Interface) error {
	for _, iface := range ifaces {
		fd, err := openPacketSocket(iface.Index)
		if err != nil {
			c.close()
			return fmt.Errorf("could not watch %s: %w", iface.Name, err)
		}
		c.fds = append(c.fds, fd)
		c.wg.Add(1)
		go c.readLoop(ctx, fd)
	}
	go func() {
		<-ctx.Done()
		c.close()
	}()
	return nil
}

func (c *capture) close() {
	c.once.Do(func() {
		for _, fd := range c.fds {
			_ = syscall.Close(fd)
		}
		c.wg.Wait()
	})
}

func openPacketSocket(ifindex int) (int, error) {
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(ethPAll)))
	if err != nil {
		if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
			return -1, fmt.Errorf("need root or CAP_NET_RAW")
		}
		return -1, err
	}
	_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 8<<20)
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(ethPAll), Ifindex: ifindex}); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func (c *capture) readLoop(ctx context.Context, fd int) {
	defer c.wg.Done()
	buf := make([]byte, 65536)
	for {
		n, _, err := syscall.Recvfrom(fd, buf, 0)
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
				select {
				case <-ctx.Done():
					return
				case <-time.After(10 * time.Millisecond):
					continue
				}
			}
			if ctx.Err() != nil || errors.Is(err, syscall.EBADF) {
				return
			}
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			continue
		}
		if n <= 0 {
			continue
		}
		if ev, ok := parsePacket(buf[:n]); ok {
			c.state.onEvent(ev)
		}
	}
}

func htons(v uint16) uint16 { return (v<<8)&0xff00 | v>>8 }

func parsePacket(pkt []byte) (event, bool) {
	l3, family, ok := locateIP(pkt)
	if !ok {
		return event{}, false
	}

	var l4, end int
	if family == 4 {
		if len(pkt) < l3+20 {
			return event{}, false
		}
		vihl := pkt[l3]
		if vihl>>4 != 4 {
			return event{}, false
		}
		ihl := int(vihl&0x0f) * 4
		if ihl < 20 || len(pkt) < l3+ihl {
			return event{}, false
		}
		if pkt[l3+9] != syscall.IPPROTO_TCP {
			return event{}, false
		}
		ipLen := int(binary.BigEndian.Uint16(pkt[l3+2 : l3+4]))
		if ipLen < ihl {
			return event{}, false
		}
		end = len(pkt)
		if l3+ipLen <= len(pkt) {
			end = l3 + ipLen
		}
		l4 = l3 + ihl
	} else {
		if len(pkt) < l3+40 {
			return event{}, false
		}
		if pkt[l3+6] != syscall.IPPROTO_TCP {
			return event{}, false
		}
		payloadLen := int(binary.BigEndian.Uint16(pkt[l3+4 : l3+6]))
		end = len(pkt)
		if payloadLen > 0 && l3+40+payloadLen <= len(pkt) {
			end = l3 + 40 + payloadLen
		}
		l4 = l3 + 40
	}

	if end < l4+20 || len(pkt) < l4+20 {
		return event{}, false
	}
	sport := binary.BigEndian.Uint16(pkt[l4 : l4+2])
	dport := binary.BigEndian.Uint16(pkt[l4+2 : l4+4])
	seq := binary.BigEndian.Uint32(pkt[l4+4 : l4+8])
	doff := int(pkt[l4+12]>>4) * 4
	if doff < 20 || end < l4+doff {
		return event{}, false
	}
	poff := l4 + doff
	payload := pkt[poff:end]
	if len(payload) < minReq {
		return event{}, false
	}

	kind := uint8(kindRequest)
	if isHTTPRequest(payload) {
		kind = kindRequest
	} else if isHTTPResponse(payload) {
		kind = kindResponse
	} else {
		return event{}, false
	}

	capLen := len(payload)
	limit := dataMax - 1
	if kind == kindResponse {
		limit = respCap
	}
	if capLen > limit {
		capLen = limit
	}
	if capLen <= 0 {
		return event{}, false
	}

	return event{
		ts:       time.Since(monoStart).Nanoseconds(),
		sport:    sport,
		dport:    dport,
		seq:      seq,
		family:   family,
		kind:     kind,
		totalLen: uint32(len(payload)),
		data:     payload[:capLen],
	}, true
}

func locateIP(pkt []byte) (int, uint8, bool) {
	if len(pkt) >= 14 {
		etype := binary.BigEndian.Uint16(pkt[12:14])
		switch etype {
		case ethPIP:
			return 14, 4, true
		case ethPIPv6:
			return 14, 6, true
		}
	}
	if len(pkt) > 0 {
		switch pkt[0] >> 4 {
		case 4:
			return 0, 4, true
		case 6:
			return 0, 6, true
		}
	}
	return 0, 0, false
}

func isHTTPRequest(p []byte) bool {
	return bytes.HasPrefix(p, []byte("GET ")) ||
		bytes.HasPrefix(p, []byte("PUT ")) ||
		bytes.HasPrefix(p, []byte("HEAD ")) ||
		bytes.HasPrefix(p, []byte("POST ")) ||
		bytes.HasPrefix(p, []byte("TRACE ")) ||
		bytes.HasPrefix(p, []byte("PATCH ")) ||
		bytes.HasPrefix(p, []byte("DELETE ")) ||
		bytes.HasPrefix(p, []byte("OPTIONS ")) ||
		bytes.HasPrefix(p, []byte("CONNECT "))
}

func isHTTPResponse(p []byte) bool { return bytes.HasPrefix(p, []byte("HTTP/")) }

/* ---- state -------------------------------------------------------- */

type endpointRow struct {
	method string
	host   string
	path   string

	count int
	prev  int
	rate  int
	peak  int
	bytes uint64

	first  time.Time
	last   time.Time
	hist   []int
	lat    []float64
	status map[int]int
	lastMS *float64
}

type pendingReq struct {
	ts  int64
	key string
	at  time.Time
}

type totals struct {
	reqs    uint64
	bytes   uint64
	startAt time.Time
}

type State struct {
	mu        sync.Mutex
	keepQuery bool
	stats     map[string]*endpointRow
	seen      map[string]time.Time
	pending   map[string][]pendingReq
	totals    totals
	sel       int
	focusKey  string
	dupes     int
}

func newState(keepQuery bool) *State {
	return &State{
		keepQuery: keepQuery,
		stats:     map[string]*endpointRow{},
		seen:      map[string]time.Time{},
		pending:   map[string][]pendingReq{},
		totals:    totals{startAt: time.Now()},
	}
}

func (s *State) onEvent(ev event) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isDuplicateLocked(ev, now) {
		return
	}
	if ev.kind == kindResponse {
		s.onResponseLocked(ev, now)
		return
	}
	s.onRequestLocked(ev, now)
}

func (s *State) isDuplicateLocked(ev event, now time.Time) bool {
	key := fmt.Sprintf("%d:%d>%d#%d", ev.family, ev.sport, ev.dport, ev.seq)
	if _, ok := s.seen[key]; ok {
		s.dupes++
		return true
	}
	s.seen[key] = now
	return false
}

func (s *State) onRequestLocked(ev event, now time.Time) {
	method, host, path, ok := parseRequest(ev.data, s.keepQuery)
	if !ok {
		return
	}
	key := method + " " + host + " " + path
	row := s.stats[key]
	if row == nil {
		row = &endpointRow{
			method: method,
			host:   host,
			path:   path,
			first:  now,
			last:   now,
			status: map[int]int{},
		}
		s.stats[key] = row
	}
	row.count++
	row.last = now
	row.bytes += uint64(ev.totalLen)
	s.totals.reqs++
	s.totals.bytes += uint64(ev.totalLen)

	fkey := flowKey(ev)
	s.pending[fkey] = append(s.pending[fkey], pendingReq{ts: ev.ts, key: key, at: now})
	if len(s.pending[fkey]) > 64 {
		s.pending[fkey] = s.pending[fkey][1:]
	}
}

func (s *State) onResponseLocked(ev event, now time.Time) {
	fkey := flowKey(ev)
	q := s.pending[fkey]
	if len(q) == 0 {
		return
	}
	req := q[0]
	q = q[1:]
	if len(q) == 0 {
		delete(s.pending, fkey)
	} else {
		s.pending[fkey] = q
	}

	row := s.stats[req.key]
	if row == nil {
		return
	}
	ms := float64(ev.ts-req.ts) / 1e6
	if ms < 0 {
		ms = 0
	}
	row.lat = append(row.lat, ms)
	if len(row.lat) > latLen {
		row.lat = row.lat[1:]
	}
	row.lastMS = &row.lat[len(row.lat)-1]

	if code := parseStatus(ev.data); code != 0 {
		row.status[code]++
	}
	_ = now
}

func flowKey(ev event) string {
	lo, hi := ev.sport, ev.dport
	if lo > hi {
		lo, hi = hi, lo
	}
	return fmt.Sprintf("%d:%d-%d", ev.family, lo, hi)
}

func parseRequest(data []byte, keepQuery bool) (string, string, string, bool) {
	text := bytesToLatin1(data)
	if i := strings.Index(text, "\r\n\r\n"); i >= 0 {
		text = text[:i]
	}
	lines := strings.Split(text, "\r\n")
	if len(lines) == 0 {
		return "", "", "", false
	}
	parts := strings.Fields(lines[0])
	if len(parts) != 3 || !isMethod(parts[0]) || !strings.HasPrefix(parts[2], "HTTP/") {
		return "", "", "", false
	}
	method := parts[0]
	target := parts[1]
	host := ""

	for _, line := range lines[1:] {
		c := strings.IndexByte(line, ':')
		if c > 0 && strings.EqualFold(line[:c], "host") {
			host = strings.TrimSpace(line[c+1:])
			break
		}
	}

	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		rest := target[strings.Index(target, "://")+3:]
		slash := strings.IndexByte(rest, '/')
		if host == "" {
			if slash >= 0 {
				host = rest[:slash]
			} else {
				host = rest
			}
		}
		if slash >= 0 {
			target = rest[slash:]
		} else {
			target = "/"
		}
	}

	path := target
	if !keepQuery {
		if q := strings.IndexByte(path, '?'); q >= 0 {
			path = path[:q]
		}
	}
	if host == "" {
		host = "-"
	}
	return method, host, path, true
}

func parseStatus(data []byte) int {
	line := bytesToLatin1(data)
	if i := strings.Index(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	if !strings.HasPrefix(line, "HTTP/") {
		return 0
	}
	fields := strings.Fields(line)
	if len(fields) < 2 || len(fields[1]) != 3 {
		return 0
	}
	code, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0
	}
	return code
}

func bytesToLatin1(data []byte) string {
	var b strings.Builder
	for _, c := range data {
		if c == 0 {
			break
		}
		b.WriteByte(c)
	}
	return b.String()
}

func isMethod(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'A' || s[i] > 'Z' {
			return false
		}
	}
	return true
}

func runSampler(ctx context.Context, state *State) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			state.sampleRates()
		}
	}
}

func (s *State) sampleRates() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range s.stats {
		row.rate = row.count - row.prev
		row.prev = row.count
		if row.rate > row.peak {
			row.peak = row.rate
		}
		row.hist = append(row.hist, row.rate)
		if len(row.hist) > histLen {
			row.hist = row.hist[1:]
		}
	}
	for key, t := range s.seen {
		if now.Sub(t) > 4*time.Second {
			delete(s.seen, key)
		}
	}
	for key, q := range s.pending {
		for len(q) > 0 && now.Sub(q[0].at) > 10*time.Second {
			q = q[1:]
		}
		if len(q) == 0 {
			delete(s.pending, key)
		} else {
			s.pending[key] = q
		}
	}
}

func (s *State) moveSel(delta int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.stats)
	if n == 0 {
		return
	}
	s.sel += delta
	if s.sel < 0 {
		s.sel = 0
	}
	if s.sel >= n {
		s.sel = n - 1
	}
}

func (s *State) enterDetail() {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := s.sortedRowsLocked()
	if len(rows) == 0 {
		return
	}
	if s.sel < 0 {
		s.sel = 0
	}
	if s.sel >= len(rows) {
		s.sel = len(rows) - 1
	}
	s.focusKey = endpointKey(rows[s.sel])
}

func (s *State) exitDetail() {
	s.mu.Lock()
	s.focusKey = ""
	s.mu.Unlock()
}

func (s *State) focused() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.focusKey != ""
}

func endpointKey(row *endpointRow) string { return row.method + " " + row.host + " " + row.path }

type endpointView struct {
	key    string
	method string
	host   string
	path   string
	count  int
	rate   int
	peak   int
	bytes  uint64
	first  time.Time
	last   time.Time
	hist   []int
	lat    []float64
	status map[int]int
}

type totalsView struct {
	reqs    uint64
	bytes   uint64
	startAt time.Time
}

type snapshot struct {
	rows          []endpointView
	totals        totalsView
	endpointCount int
	sel           int
	focusKey      string
	focus         *endpointView
	dupes         int
}

func (s *State) snapshot() snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows := s.sortedRowsLocked()
	if len(rows) == 0 {
		s.sel = 0
	} else if s.sel >= len(rows) {
		s.sel = len(rows) - 1
	}

	views := make([]endpointView, 0, len(rows))
	var focus *endpointView
	for _, row := range rows {
		view := copyEndpointView(row)
		views = append(views, view)
		if s.focusKey != "" && view.key == s.focusKey {
			v := view
			focus = &v
		}
	}
	return snapshot{
		rows:          views,
		totals:        totalsView{reqs: s.totals.reqs, bytes: s.totals.bytes, startAt: s.totals.startAt},
		endpointCount: len(s.stats),
		sel:           s.sel,
		focusKey:      s.focusKey,
		focus:         focus,
		dupes:         s.dupes,
	}
}

func (s *State) sortedRowsLocked() []*endpointRow {
	rows := make([]*endpointRow, 0, len(s.stats))
	for _, row := range s.stats {
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].count == rows[j].count {
			return endpointKey(rows[i]) < endpointKey(rows[j])
		}
		return rows[i].count > rows[j].count
	})
	return rows
}

func copyEndpointView(row *endpointRow) endpointView {
	status := make(map[int]int, len(row.status))
	for k, v := range row.status {
		status[k] = v
	}
	return endpointView{
		key:    endpointKey(row),
		method: row.method,
		host:   row.host,
		path:   row.path,
		count:  row.count,
		rate:   row.rate,
		peak:   row.peak,
		bytes:  row.bytes,
		first:  row.first,
		last:   row.last,
		hist:   append([]int(nil), row.hist...),
		lat:    append([]float64(nil), row.lat...),
		status: status,
	}
}

/* ---- verify ------------------------------------------------------- */

func runVerify(ctx context.Context, state *State, ifaces []net.Interface, duration time.Duration) {
	idx := make([]string, 0, len(ifaces))
	for _, iface := range ifaces {
		idx = append(idx, strconv.Itoa(iface.Index))
	}
	fmt.Println("[verify] attaching to ifindexes", strings.Join(idx, ","))

	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}

	snap := state.snapshot()
	fmt.Printf("[verify] deduped %d loopback double-sightings\n", snap.dupes)
	fmt.Println("[verify] aggregated endpoints (count desc):")
	for _, row := range snap.rows {
		extra := ""
		if len(row.status) > 0 {
			extra += "  status=" + plainStatus(row.status)
		}
		if len(row.lat) > 0 {
			extra += fmt.Sprintf("  latency=p50:%s p95:%s samples:%d", fmtMS(percentile(row.lat, 50)), fmtMS(percentile(row.lat, 95)), len(row.lat))
		}
		fmt.Printf("  %3d  %s %s %s%s\n", row.count, row.method, row.host, row.path, extra)
	}
}

func plainStatus(status map[int]int) string {
	type pair struct{ code, count int }
	pairs := make([]pair, 0, len(status))
	for code, count := range status {
		pairs = append(pairs, pair{code: code, count: count})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].count > pairs[j].count })
	if len(pairs) > 6 {
		pairs = pairs[:6]
	}
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, fmt.Sprintf("%dx%d", p.code, p.count))
	}
	return strings.Join(parts, ",")
}

/* ---- TUI ---------------------------------------------------------- */

type keyEvent struct {
	name string
	ch   byte
}

const (
	keyUp       = "up"
	keyDown     = "down"
	keyLeft     = "left"
	keyPageUp   = "pageup"
	keyPageDown = "pagedown"
	keyEnter    = "enter"
	keyEsc      = "esc"
	keyCtrlC    = "ctrl-c"
	keyChar     = "char"
)

type rawMode struct {
	fd   int
	orig *syscall.Termios
}

func runTUI(ctx context.Context, cancel context.CancelFunc, state *State, ifaceLabel string) error {
	raw, err := enableRaw(int(os.Stdin.Fd()))
	if err != nil {
		return err
	}
	defer raw.restore()
	defer func() {
		fmt.Fprint(os.Stdout, "\x1b[0m\x1b[?25h\x1b[2J\x1b[H\x1b]0;\x07")
	}()

	keys := make(chan keyEvent, 32)
	go readKeys(ctx, int(os.Stdin.Fd()), keys)

	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()

	listTop := 0
	render := func() {
		w, h := terminalSize()
		snap := state.snapshot()
		draw(os.Stdout, snap, ifaceLabel, w, h, &listTop)
	}
	render()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			render()
		case key, ok := <-keys:
			if !ok {
				return nil
			}
			handleKey(key, state, cancel)
			render()
		}
	}
}

func handleKey(key keyEvent, state *State, cancel context.CancelFunc) {
	focused := state.focused()
	switch key.name {
	case keyCtrlC:
		cancel()
	case keyEsc, keyLeft:
		if focused {
			state.exitDetail()
		}
	case keyDown:
		if !focused {
			state.moveSel(1)
		}
	case keyUp:
		if !focused {
			state.moveSel(-1)
		}
	case keyPageDown:
		if !focused {
			state.moveSel(10)
		}
	case keyPageUp:
		if !focused {
			state.moveSel(-10)
		}
	case keyEnter:
		if !focused {
			state.enterDetail()
		}
	case keyChar:
		switch key.ch {
		case 'q':
			if focused {
				state.exitDetail()
			} else {
				cancel()
			}
		case 'j':
			if !focused {
				state.moveSel(1)
			}
		case 'k':
			if !focused {
				state.moveSel(-1)
			}
		}
	}
}

func enableRaw(fd int) (*rawMode, error) {
	orig, err := getTermios(fd)
	if err != nil {
		return nil, err
	}
	raw := *orig
	raw.Iflag &^= syscall.BRKINT | syscall.ICRNL | syscall.INPCK | syscall.ISTRIP | syscall.IXON
	raw.Oflag &^= syscall.OPOST
	raw.Cflag |= syscall.CS8
	raw.Lflag &^= syscall.ECHO | syscall.ICANON | syscall.IEXTEN | syscall.ISIG
	raw.Cc[syscall.VMIN] = 0
	raw.Cc[syscall.VTIME] = 1
	if err := setTermios(fd, &raw); err != nil {
		return nil, err
	}
	return &rawMode{fd: fd, orig: orig}, nil
}

func (r *rawMode) restore() {
	if r != nil && r.orig != nil {
		_ = setTermios(r.fd, r.orig)
		_ = syscall.SetNonblock(r.fd, false)
	}
}

func getTermios(fd int) (*syscall.Termios, error) {
	var term syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&term)))
	if errno != 0 {
		return nil, errno
	}
	return &term, nil
}

func setTermios(fd int, term *syscall.Termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCSETS), uintptr(unsafe.Pointer(term)))
	if errno != 0 {
		return errno
	}
	return nil
}

func readKeys(ctx context.Context, fd int, out chan<- keyEvent) {
	defer close(out)
	_ = syscall.SetNonblock(fd, true)
	defer syscall.SetNonblock(fd, false)

	buf := make([]byte, 64)
	var esc []byte
	var escAt time.Time
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, err := syscall.Read(fd, buf)
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
				if len(esc) > 0 && time.Since(escAt) > 50*time.Millisecond {
					sendKey(ctx, out, keyEvent{name: keyEsc})
					esc = nil
				}
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return
		}
		if n == 0 {
			if len(esc) > 0 && time.Since(escAt) > 50*time.Millisecond {
				sendKey(ctx, out, keyEvent{name: keyEsc})
				esc = nil
			}
			continue
		}
		for _, b := range buf[:n] {
			if len(esc) > 0 || b == 0x1b {
				if len(esc) == 0 {
					escAt = time.Now()
				}
				esc = append(esc, b)
				if key, ok := decodeEscape(esc); ok {
					sendKey(ctx, out, key)
					esc = nil
				} else if len(esc) > 5 {
					sendKey(ctx, out, keyEvent{name: keyEsc})
					esc = nil
				}
				continue
			}
			switch b {
			case 3:
				sendKey(ctx, out, keyEvent{name: keyCtrlC})
			case '\r', '\n':
				sendKey(ctx, out, keyEvent{name: keyEnter})
			default:
				sendKey(ctx, out, keyEvent{name: keyChar, ch: b})
			}
		}
	}
}

func sendKey(ctx context.Context, out chan<- keyEvent, key keyEvent) {
	select {
	case <-ctx.Done():
	case out <- key:
	}
}

func decodeEscape(seq []byte) (keyEvent, bool) {
	if len(seq) < 2 || seq[0] != 0x1b {
		return keyEvent{}, false
	}
	if seq[1] == '[' {
		if len(seq) == 3 {
			switch seq[2] {
			case 'A':
				return keyEvent{name: keyUp}, true
			case 'B':
				return keyEvent{name: keyDown}, true
			case 'C':
				return keyEvent{name: "right"}, true
			case 'D':
				return keyEvent{name: keyLeft}, true
			}
		}
		if len(seq) == 4 && seq[3] == '~' {
			switch seq[2] {
			case '5':
				return keyEvent{name: keyPageUp}, true
			case '6':
				return keyEvent{name: keyPageDown}, true
			}
		}
	}
	if seq[1] == 'O' && len(seq) == 3 {
		switch seq[2] {
		case 'A':
			return keyEvent{name: keyUp}, true
		case 'B':
			return keyEvent{name: keyDown}, true
		case 'D':
			return keyEvent{name: keyLeft}, true
		}
	}
	return keyEvent{}, false
}

func draw(w io.Writer, snap snapshot, ifaceLabel string, width, height int, listTop *int) {
	if width < 60 {
		width = 60
	}
	if height < 10 {
		height = 10
	}
	var out strings.Builder
	out.WriteString("\x1b[?25l\x1b[H\x1b[2J")
	out.WriteString(fmt.Sprintf("\x1b]0;httpinspect - %s reqs - %d endpoints\x07", fmtCount(snap.totals.reqs), snap.endpointCount))

	lines := make([]string, 0, height)
	lines = append(lines, statusLine(ifaceLabel, width))
	if snap.focusKey != "" {
		lines = append(lines, detailPanel(snap, width, height)...)
	} else {
		lines = append(lines, listPanel(snap, width, height, listTop)...)
	}
	lines = append(lines, footerLine(snap, width))
	lines = append(lines, legendLine(snap.focusKey != "", width))

	for len(lines) < height {
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[:height]
	}
	for i, line := range lines {
		if i > 0 {
			out.WriteString("\r\n")
		}
		out.WriteString(line)
		out.WriteString("\x1b[K")
	}
	_, _ = io.WriteString(w, out.String())
}

func statusLine(ifaceLabel string, width int) string {
	left := bold(rgb(0x4fc1ff, "httpinspect"))
	right := dim("  iface: " + ifaceLabel + "  ·  plaintext HTTP only")
	return left + right + strings.Repeat(" ", max(0, width-visibleLen("httpinspect")-visibleLen("  iface: "+ifaceLabel+"  ·  plaintext HTTP only")))
}

func footerLine(snap snapshot, width int) string {
	line := fmt.Sprintf("%s reqs  ·  %d endpoints  ·  %s seen  ·  up %s",
		fmtCount(snap.totals.reqs), snap.endpointCount, fmtBytes(snap.totals.bytes), fmtUptime(time.Since(snap.totals.startAt)))
	return dim(clip(line, width))
}

func legendLine(detail bool, width int) string {
	var line string
	if detail {
		line = colorIdx(39, "esc / left") + dim(" back    ") + colorIdx(39, "q") + dim(" list    ") + colorIdx(39, "Ctrl-C") + dim(" quit")
	} else {
		line = colorIdx(39, "up/down") + dim(" move    ") + colorIdx(39, "PgUp/Dn") + dim(" page    ") + colorIdx(39, "Enter") + dim(" details    ") + colorIdx(39, "q / Ctrl-C") + dim(" quit")
	}
	_ = width
	return line
}

func listPanel(snap snapshot, width, height int, listTop *int) []string {
	contentW := width - 4
	vis := max(3, height-7)
	lines := []string{borderTop(width)}
	lines = append(lines, borderLine(headerRow(contentW), width))
	lines = append(lines, borderLine(dim(strings.Repeat("-", contentW)), width))

	if len(snap.rows) == 0 {
		lines = append(lines, borderLine(dim("waiting for HTTP requests...  (try: curl http://localhost:PORT/path)"), width))
		for len(lines) < vis+3 {
			lines = append(lines, borderLine("", width))
		}
		lines = append(lines, borderBottom(width))
		return lines
	}

	cur := max(0, min(len(snap.rows)-1, snap.sel))
	if cur < *listTop {
		*listTop = cur
	} else if cur >= *listTop+vis {
		*listTop = cur - vis + 1
	}
	*listTop = max(0, min(*listTop, max(0, len(snap.rows)-vis)))

	for i, row := range snap.rows[*listTop:min(len(snap.rows), *listTop+vis)] {
		rank := *listTop + i + 1
		selected := *listTop+i == cur
		line := formatListRow(row, rank, selected, contentW)
		lines = append(lines, borderLine(line, width))
	}
	for len(lines) < vis+3 {
		lines = append(lines, borderLine("", width))
	}
	lines = append(lines, borderBottom(width))
	return lines
}

func headerRow(width int) string {
	hostW, pathW := listWidths(width)
	return dim(padEnd("#", 4)) + " " + bold(padEnd("METHOD", 8)) + " " + bold(padEnd("HOST", hostW)) + " " + bold(padEnd("PATH", pathW)) + " " + bold(pad("COUNT", 8)) + " " + bold(pad("REQ/S", 8)) + " " + bold(pad("LAST", 6))
}

func formatListRow(row endpointView, rank int, selected bool, width int) string {
	hostW, pathW := listWidths(width)
	rankText := pad(strconv.Itoa(rank), 3) + " "
	if selected {
		rankText = ">" + pad(strconv.Itoa(rank), 2) + " "
	} else {
		rankText = dim(rankText)
	}
	method := colorMethod(row.method, padEnd(row.method, 8))
	host := dim(padEnd(clip(row.host, hostW), hostW))
	path := padEnd(clip(row.path, pathW), pathW)
	count := bold(rgb(0x4fc1ff, pad(fmtCount(uint64(row.count)), 8)))
	rateText := pad("·", 8)
	if row.rate > 0 {
		rateText = rgb(0x4ec9b0, pad(fmtCount(uint64(row.rate)), 8))
	} else {
		rateText = dim(rateText)
	}
	last := dim(pad(fmtAgo(row.last), 6))
	line := rankText + " " + method + " " + host + " " + path + " " + count + " " + rateText + " " + last
	if selected {
		return bgIdx(236, line)
	}
	return line
}

func listWidths(width int) (int, int) {
	hostW := 22
	fixed := 4 + 1 + 8 + 1 + hostW + 1 + 1 + 8 + 1 + 8 + 1 + 6
	pathW := width - fixed
	if pathW < 8 {
		hostW = max(8, hostW-(8-pathW))
		fixed = 4 + 1 + 8 + 1 + hostW + 1 + 1 + 8 + 1 + 8 + 1 + 6
		pathW = max(8, width-fixed)
	}
	return hostW, pathW
}

func detailPanel(snap snapshot, width, height int) []string {
	contentW := width - 4
	vis := max(3, height-7)
	lines := []string{borderTop(width)}
	if snap.focus == nil {
		lines = append(lines, borderLine(dim("endpoint no longer tracked - press esc to go back"), width))
		for len(lines) < vis+3 {
			lines = append(lines, borderLine("", width))
		}
		lines = append(lines, borderBottom(width))
		return lines
	}
	row := *snap.focus
	share := 0.0
	if snap.totals.reqs > 0 {
		share = (float64(row.count) / float64(snap.totals.reqs)) * 100
	}
	lat := dim("no responses paired yet")
	if len(row.lat) > 0 {
		lat = fmt.Sprintf("p50 %s  ·  p95 %s  ·  max %s  ·  %d samples",
			fmtMS(percentile(row.lat, 50)), fmtMS(percentile(row.lat, 95)), fmtMS(maxFloat(row.lat)), len(row.lat))
	}
	sparkW := max(10, min(contentW-16, max(len(row.hist), len(row.lat))))
	body := []string{
		bold(colorMethod(row.method, padEnd(row.method, 8)) + " " + clip(row.host+row.path, contentW-9)),
		"",
		field("Requests", bold(rgb(0x4fc1ff, fmtCount(uint64(row.count))))+dim(fmt.Sprintf("  (%d)", row.count))),
		field("Share", fmt.Sprintf("%.1f%% of all requests", share)),
		field("Req/s now", rateNow(row)+dim(fmt.Sprintf("   peak %d/s", row.peak))),
		field("Latency", lat),
		field("Status", statusSpans(row.status)),
		field("Bytes", fmtBytes(row.bytes)+dim(" on the wire")),
		field("First seen", fmtAgo(row.first)+" ago"),
		field("Last seen", fmtAgo(row.last)+" ago"),
		"",
		rgb(0x9a9a9a, "Req/s, last minute"),
		rgb(0x4ec9b0, sparklineInts(row.hist, sparkW, row.peak)),
		"",
		rgb(0x9a9a9a, "Latency, recent responses"),
		rgb(0x4fc1ff, sparklineFloat(row.lat, sparkW, 0)),
	}
	for _, line := range body {
		if len(lines) >= vis+3 {
			break
		}
		lines = append(lines, borderLine(line, width))
	}
	for len(lines) < vis+3 {
		lines = append(lines, borderLine("", width))
	}
	lines = append(lines, borderBottom(width))
	return lines
}

func field(name, value string) string { return colorIdx(244, padEnd(name, 12)) + value }

func rateNow(row endpointView) string {
	if row.rate > 0 {
		return rgb(0x4ec9b0, strconv.Itoa(row.rate))
	}
	return dim("0")
}

func statusSpans(status map[int]int) string {
	if len(status) == 0 {
		return dim("- no responses paired yet")
	}
	type pair struct{ code, count int }
	pairs := make([]pair, 0, len(status))
	for code, count := range status {
		pairs = append(pairs, pair{code: code, count: count})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].count > pairs[j].count })
	if len(pairs) > 6 {
		pairs = pairs[:6]
	}
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, statusColor(p.code, strconv.Itoa(p.code))+dim(fmt.Sprintf("x%d", p.count)))
	}
	return strings.Join(parts, "  ")
}

func borderTop(width int) string    { return "+" + strings.Repeat("-", max(0, width-2)) + "+" }
func borderBottom(width int) string { return "+" + strings.Repeat("-", max(0, width-2)) + "+" }
func borderLine(s string, width int) string {
	_ = width
	return "| " + s + " |"
}

func terminalSize() (int, int) {
	type winsize struct {
		Row    uint16
		Col    uint16
		Xpixel uint16
		Ypixel uint16
	}
	ws := winsize{}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stdout.Fd(), uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&ws)))
	if errno == 0 && ws.Col > 0 && ws.Row > 0 {
		return int(ws.Col), int(ws.Row)
	}
	return 100, 30
}

func isCharDevice(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

/* ---- formatting --------------------------------------------------- */

func fmtCount(n uint64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 10_000 {
		return fmt.Sprintf("%.0fk", float64(n)/1000)
	}
	if n >= 1000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return strconv.FormatUint(n, 10)
}

func fmtBytes(n uint64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	v := float64(n)
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d%s", n, units[i])
	}
	return fmt.Sprintf("%.1f%s", v, units[i])
}

func fmtAgo(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	s := int(time.Since(t).Seconds())
	if s < 1 {
		return "now"
	}
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	if s < 3600 {
		return fmt.Sprintf("%dm", s/60)
	}
	return fmt.Sprintf("%dh", s/3600)
}

func fmtUptime(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	return fmt.Sprintf("%dm%ds", s/60, s%60)
}

func fmtMS(ms float64) string {
	if ms >= 1000 {
		return fmt.Sprintf("%.2fs", ms/1000)
	}
	if ms >= 10 {
		return fmt.Sprintf("%.0fms", ms)
	}
	if ms >= 1 {
		return fmt.Sprintf("%.1fms", ms)
	}
	return fmt.Sprintf("%.2fms", ms)
}

func percentile(values []float64, p int) float64 {
	if len(values) == 0 {
		return 0
	}
	v := append([]float64(nil), values...)
	sort.Float64s(v)
	i := int(float64(len(v))*float64(p)/100.0+0.999999) - 1
	if i < 0 {
		i = 0
	}
	if i >= len(v) {
		i = len(v) - 1
	}
	return v[i]
}

func sparklineInts(values []int, width int, maxValue int) string {
	floatValues := make([]float64, len(values))
	for i, v := range values {
		floatValues[i] = float64(v)
	}
	return sparklineFloat(floatValues, width, float64(maxValue))
}

func sparklineFloat(values []float64, width int, maxValue float64) string {
	blocks := []rune(" ▁▂▃▄▅▆▇█")
	if width <= 0 {
		return ""
	}
	if len(values) > width {
		values = values[len(values)-width:]
	}
	hi := maxValue
	if hi < 1 {
		hi = 1
	}
	for _, v := range values {
		if v > hi {
			hi = v
		}
	}
	var b strings.Builder
	for i := 0; i < width-len(values); i++ {
		b.WriteRune(' ')
	}
	for _, v := range values {
		idx := int((v/hi)*8.0 + 0.5)
		if idx < 0 {
			idx = 0
		}
		if idx > 8 {
			idx = 8
		}
		b.WriteRune(blocks[idx])
	}
	return b.String()
}

func colorMethod(method, s string) string {
	switch method {
	case "GET":
		return rgb(0x4ec9b0, s)
	case "POST":
		return rgb(0xdcdcaa, s)
	case "PUT":
		return rgb(0x9cdcfe, s)
	case "PATCH":
		return rgb(0xc586c0, s)
	case "DELETE":
		return rgb(0xf48771, s)
	case "HEAD", "OPTIONS", "CONNECT", "TRACE":
		return colorIdx(8, s)
	default:
		return colorIdx(7, s)
	}
}

func statusColor(code int, s string) string {
	switch {
	case code >= 500:
		return rgb(0xf48771, s)
	case code >= 400:
		return rgb(0xdcdcaa, s)
	case code >= 300:
		return rgb(0x9cdcfe, s)
	case code >= 200:
		return rgb(0x4ec9b0, s)
	default:
		return colorIdx(7, s)
	}
}

func rgb(hex int, s string) string {
	r := (hex >> 16) & 0xff
	g := (hex >> 8) & 0xff
	b := hex & 0xff
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s\x1b[0m", r, g, b, s)
}

func colorIdx(idx int, s string) string { return fmt.Sprintf("\x1b[38;5;%dm%s\x1b[0m", idx, s) }
func bgIdx(idx int, s string) string    { return fmt.Sprintf("\x1b[48;5;%dm%s\x1b[0m", idx, s) }
func bold(s string) string              { return "\x1b[1m" + s + "\x1b[0m" }
func dim(s string) string               { return "\x1b[2m" + s + "\x1b[0m" }
func pad(s string, w int) string        { return fmt.Sprintf("%*s", w, s) }
func padEnd(s string, w int) string     { return fmt.Sprintf("%-*s", w, s) }

func clip(s string, width int) string {
	if width <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= width {
		return s
	}
	if width == 1 {
		return "~"
	}
	return string(r[:width-1]) + "~"
}

func visibleLen(s string) int { return len([]rune(s)) }
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func maxFloat(v []float64) float64 {
	m := 0.0
	for _, x := range v {
		if x > m {
			m = x
		}
	}
	return m
}
