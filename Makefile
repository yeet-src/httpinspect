.PHONY: all build verify clean

GO ?= go
BIN ?= bin/httpinspect

all: build

build:
	@mkdir -p bin
	$(GO) build -trimpath -ldflags='-s -w' -o $(BIN) .

verify: build
	$(BIN) --verify --iface lo

clean:
	rm -f $(BIN)
