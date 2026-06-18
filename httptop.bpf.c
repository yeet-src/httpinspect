// SPDX-License-Identifier: GPL-2.0
//
// httptop — capture plaintext HTTP request lines at the TC layer.
//
// Attaches SchedCls programs to every host interface (incl. loopback) via TCX
// (ingress + egress). We locate the IP header by sniffing the link layer
// (Ethernet/loopback carry a 14-byte L2 header; tun/raw-IP devices carry none),
// then read payload bytes with the absolute `bpf_skb_load_bytes`, which copies
// across paged frags — the relative-to-network-header helper only sees the
// linear head and EFAULTs on the (usually paged) TCP payload.
//
// Cheap in-kernel filter: only segments whose payload *starts* with a known
// HTTP method token (a request) or "HTTP/" (a response status line) cross the
// ringbuf. ACKs and non-HTTP traffic never leave the kernel. Each event carries
// a monotonic kernel timestamp; JS pairs each response with the oldest pending
// request on the same flow to derive on-the-wire latency, and parses the status
// code. JS parses the request line + Host header from requests.
//
// Plaintext only: TLS payloads are ciphertext here, so HTTPS is not visible
// (that would need a uprobe on SSL_write/SSL_read). Both IPv4 and IPv6 are
// handled; IPv6 packets with extension headers (rare for TCP) are skipped.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define ETH_P_IP   0x0800
#define ETH_P_IPV6 0x86DD
#define L2_ETH     14          /* Ethernet / loopback link header */

#define TCX_NEXT (-1)          /* passive observer: run next prog / default-pass */

#define DATA_MAX 512           /* must be a power of two (see mask below) */
#define MIN_REQ  16            /* "GET / HTTP/1.1\r\n" is already 16 bytes */

#define DIR_EGRESS  0
#define DIR_INGRESS 1

#define KIND_REQUEST  0
#define KIND_RESPONSE 1

#define RESP_CAP 32            /* responses: only the status line is parsed */

struct http_event {
    __u64 ts;           /* bpf_ktime_get_ns() at capture (monotonic) */
    __u16 sport;
    __u16 dport;
    __u32 seq;
    __u8  family;       /* 4 or 6 */
    __u8  dir;
    __u8  kind;         /* KIND_REQUEST | KIND_RESPONSE */
    __u8  pad;
    __u32 total_len;    /* full payload length on the wire */
    __u32 captured;     /* bytes actually copied into data[] */
    __u8  data[DATA_MAX];
};
/* anchor so the struct survives into BTF for JS-side decoding */
__attribute__((used)) static const struct http_event __http_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 8 << 20);
} events SEC(".maps");

/* Does the 8-byte prefix begin with an HTTP method token (method + space)? */
static __always_inline int is_http_request(const __u8 *m)
{
    if (m[0] == 'G' && m[1] == 'E' && m[2] == 'T' && m[3] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'U' && m[2] == 'T' && m[3] == ' ') return 1;
    if (m[0] == 'H' && m[1] == 'E' && m[2] == 'A' && m[3] == 'D' && m[4] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'O' && m[2] == 'S' && m[3] == 'T' && m[4] == ' ') return 1;
    if (m[0] == 'T' && m[1] == 'R' && m[2] == 'A' && m[3] == 'C' && m[4] == 'E' && m[5] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'A' && m[2] == 'T' && m[3] == 'C' && m[4] == 'H' && m[5] == ' ') return 1;
    if (m[0] == 'D' && m[1] == 'E' && m[2] == 'L' && m[3] == 'E' && m[4] == 'T' && m[5] == 'E' && m[6] == ' ') return 1;
    if (m[0] == 'O' && m[1] == 'P' && m[2] == 'T' && m[3] == 'I' && m[4] == 'O' && m[5] == 'N' && m[6] == 'S' && m[7] == ' ') return 1;
    if (m[0] == 'C' && m[1] == 'O' && m[2] == 'N' && m[3] == 'N' && m[4] == 'E' && m[5] == 'C' && m[6] == 'T' && m[7] == ' ') return 1;
    return 0;
}

/* Does the prefix begin with an HTTP response status line ("HTTP/")? */
static __always_inline int is_http_response(const __u8 *m)
{
    return m[0] == 'H' && m[1] == 'T' && m[2] == 'T' && m[3] == 'P' && m[4] == '/';
}

static __always_inline int handle(struct __sk_buff *skb, __u8 dir)
{
    /* Locate the IP header. Prefer the Ethernet/loopback hypothesis (L2=14):
       its ethertype is unambiguous. Fall back to raw IP at offset 0 (tun). */
    __u32 l3;
    __u8  family;
    __u16 etype = 0;
    bpf_skb_load_bytes(skb, 12, &etype, 2);
    if (etype == bpf_htons(ETH_P_IP))        { l3 = L2_ETH; family = 4; }
    else if (etype == bpf_htons(ETH_P_IPV6)) { l3 = L2_ETH; family = 6; }
    else {
        __u8 b0 = 0;
        if (bpf_skb_load_bytes(skb, 0, &b0, 1) < 0)
            return TCX_NEXT;
        __u8 v = b0 >> 4;
        if (v == 4)      { l3 = 0; family = 4; }
        else if (v == 6) { l3 = 0; family = 6; }
        else return TCX_NEXT;
    }

    /* Advance to the TCP header. */
    __u32 l4;
    if (family == 4) {
        __u8 vihl = 0, proto = 0;
        if (bpf_skb_load_bytes(skb, l3, &vihl, 1) < 0)
            return TCX_NEXT;
        if ((vihl >> 4) != 4)
            return TCX_NEXT;
        __u32 ihl = (vihl & 0x0f) * 4;
        if (ihl < 20)
            return TCX_NEXT;
        if (bpf_skb_load_bytes(skb, l3 + 9, &proto, 1) < 0)
            return TCX_NEXT;
        if (proto != IPPROTO_TCP)
            return TCX_NEXT;
        l4 = l3 + ihl;
    } else {
        __u8 nexthdr = 0;
        if (bpf_skb_load_bytes(skb, l3 + 6, &nexthdr, 1) < 0)
            return TCX_NEXT;
        if (nexthdr != IPPROTO_TCP)          /* skip ext-header chains / non-TCP */
            return TCX_NEXT;
        l4 = l3 + 40;                        /* fixed IPv6 header */
    }

    __u16 sport = 0, dport = 0;
    __u32 seq = 0;
    __u8  doffb = 0;
    bpf_skb_load_bytes(skb, l4,      &sport, 2);
    bpf_skb_load_bytes(skb, l4 + 2,  &dport, 2);
    bpf_skb_load_bytes(skb, l4 + 4,  &seq,   4);
    if (bpf_skb_load_bytes(skb, l4 + 12, &doffb, 1) < 0)
        return TCX_NEXT;
    __u32 doff = (doffb >> 4) * 4;
    if (doff < 20)
        return TCX_NEXT;

    /* skb->len is the frag-safe total; using it sidesteps GSO (ip_tot==0). */
    __u32 poff = l4 + doff;
    if (skb->len <= poff)
        return TCX_NEXT;                     /* no payload (pure ACK/SYN) */
    __u32 plen = skb->len - poff;
    if (plen < MIN_REQ)
        return TCX_NEXT;

    /* cheap in-kernel HTTP detection on the first 8 payload bytes */
    __u8 m[8] = {};
    if (bpf_skb_load_bytes(skb, poff, m, sizeof(m)) < 0)
        return TCX_NEXT;
    __u8 kind;
    if (is_http_request(m))       kind = KIND_REQUEST;
    else if (is_http_response(m)) kind = KIND_RESPONSE;
    else                          return TCX_NEXT;

    /* Requests carry the line + Host header (parsed in JS); responses only need
       the status line, so cap them short to spare ringbuf bandwidth. */
    __u32 cap = plen;
    __u32 limit = kind == KIND_RESPONSE ? RESP_CAP : (DATA_MAX - 1);
    if (cap > limit)
        cap = limit;
    cap &= (DATA_MAX - 1);                   /* make the bound explicit for the verifier */
    if (cap == 0)
        return TCX_NEXT;

    struct http_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return TCX_NEXT;
    e->ts        = bpf_ktime_get_ns();
    e->sport     = bpf_ntohs(sport);
    e->dport     = bpf_ntohs(dport);
    e->seq       = bpf_ntohl(seq);
    e->family    = family;
    e->dir       = dir;
    e->kind      = kind;
    e->total_len = plen;
    e->captured  = cap;
    if (bpf_skb_load_bytes(skb, poff, e->data, cap) < 0) {
        bpf_ringbuf_discard(e, 0);
        return TCX_NEXT;
    }
    bpf_ringbuf_submit(e, 0);
    return TCX_NEXT;
}

SEC("tcx/ingress")
int on_ingress(struct __sk_buff *skb) { return handle(skb, DIR_INGRESS); }

SEC("tcx/egress")
int on_egress(struct __sk_buff *skb)  { return handle(skb, DIR_EGRESS); }

char LICENSE[] SEC("license") = "GPL";
