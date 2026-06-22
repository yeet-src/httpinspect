# Resolve the static build toolchain (clang, bpftool, veristat, esbuild, git, gh) — included
# by the project Makefile before build/bpf.mk, so the tools are set before any
# rule uses them. A `make CLANG=…` CLI override beats this.
#
# Tools come from a shared, per-machine cache keyed by the project's pinned
# toolchain version (build/toolchain.lock). `make toolchain` fills it,
# downloading each missing tool once from the vendored toolchain release
# (github.com/yeet-src/toolchain). The cache key is the toolchain version,
# never the template version — so updating the template reuses an existing
# cached toolchain, and bumping a tool adds a new entry beside the old one.
# Falls back to host tools on PATH when no lock is present.
#
# The vendored binaries are Linux musl-static, so the cache is only used on
# Linux. On any other host (macOS, BSD) we leave CLANG/BPFTOOL/ESBUILD/GIT/GH
# unset, falling through to host tools on PATH — macOS is an edit-here,
# build-on-Linux host for BPF work.

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
# Apple/BSD report arm64; the release assets are named aarch64. Normalize so
# the cache key and asset names line up across hosts.
UNAME_M := $(UNAME_M:arm64=aarch64)

# Only engage the vendored cache on Linux; elsewhere TOOLCHAIN_LOCK stays empty
# so the PATH fallbacks below win and the fetch targets become no-ops.
ifeq ($(UNAME_S),Linux)
TOOLCHAIN_LOCK := $(firstword $(wildcard build/toolchain.lock))
endif
ifneq ($(TOOLCHAIN_LOCK),)
  include $(TOOLCHAIN_LOCK)
  TOOLCHAIN_KEY  := v$(TOOLCHAIN_VERSION)
  YEET_CACHE_DIR ?= $(if $(XDG_CACHE_HOME),$(XDG_CACHE_HOME),$(HOME)/.cache)/yeet
  TOOLCHAIN_DIR  := $(YEET_CACHE_DIR)/toolchain/$(TOOLCHAIN_KEY)/$(UNAME_M)
  CLANG    ?= $(TOOLCHAIN_DIR)/clang
  BPFTOOL  ?= $(TOOLCHAIN_DIR)/bpftool
  VERISTAT ?= $(TOOLCHAIN_DIR)/veristat
  ESBUILD  ?= $(TOOLCHAIN_DIR)/esbuild
  GIT      ?= $(TOOLCHAIN_DIR)/git
  GH       ?= $(TOOLCHAIN_DIR)/gh
  # libbpf program headers are arch-independent: one copy per version key,
  # beside the per-arch tool dirs.
  BPF_SYSINCLUDE ?= $(YEET_CACHE_DIR)/toolchain/$(TOOLCHAIN_KEY)/include
endif

# PATH fallbacks (bpf.mk supplies the clang/bpftool fallbacks).
VERISTAT ?= veristat
ESBUILD  ?= esbuild
GIT      ?= git
GH       ?= gh

# Fill the cache for this arch, downloading any missing tool once. A no-op
# when no lock is present (PATH case).
.PHONY: toolchain
toolchain:
ifneq ($(TOOLCHAIN_LOCK),)
	@sh build/fetch-toolchain.sh "$(TOOLCHAIN_DIR)" "$(UNAME_M)" "$(TOOLCHAIN_LOCK)"
else
	@:
endif

# Fetch only git into the cache — used by `postgen` so generating a project
# doesn't pull the whole build toolchain just to initialize a repo.
.PHONY: vendored-git
vendored-git:
ifneq ($(TOOLCHAIN_LOCK),)
	@sh build/fetch-toolchain.sh "$(TOOLCHAIN_DIR)" "$(UNAME_M)" "$(TOOLCHAIN_LOCK)" git \
		|| echo "note: vendored git unavailable; postgen will fall back to host git" >&2
else
	@:
endif
