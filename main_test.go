// SPDX-License-Identifier: GPL-2.0
package main

import "testing"

func TestParseRequestCollapsesQuery(t *testing.T) {
	method, host, path, ok := parseRequest([]byte("GET /items?id=1 HTTP/1.1\r\nHost: api.local\r\n\r\n"), false)
	if !ok {
		t.Fatal("request did not parse")
	}
	if method != "GET" || host != "api.local" || path != "/items" {
		t.Fatalf("got %q %q %q", method, host, path)
	}
}

func TestParseRequestKeepsQuery(t *testing.T) {
	_, _, path, ok := parseRequest([]byte("GET /items?id=1 HTTP/1.1\r\nHost: api.local\r\n\r\n"), true)
	if !ok {
		t.Fatal("request did not parse")
	}
	if path != "/items?id=1" {
		t.Fatalf("got path %q", path)
	}
}

func TestParseRequestAbsoluteForm(t *testing.T) {
	method, host, path, ok := parseRequest([]byte("GET http://upstream.local:8080/api?q=1 HTTP/1.1\r\n\r\n"), false)
	if !ok {
		t.Fatal("request did not parse")
	}
	if method != "GET" || host != "upstream.local:8080" || path != "/api" {
		t.Fatalf("got %q %q %q", method, host, path)
	}
}

func TestParseStatus(t *testing.T) {
	if got := parseStatus([]byte("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")); got != 404 {
		t.Fatalf("got status %d", got)
	}
}
