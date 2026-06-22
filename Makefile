# Build the yeet script project.
#
#   make         — build everything (BPF objects + JS bundle)
#   make bpf     — compile bpf/*.bpf.c into bin/* only
#   make veristat — load the built object with veristat (verifier check on this kernel)
#   make bundle  — resolve npm/jsr deps and bundle the JS entry
#   make postgen — finalize a freshly generated project (git init)
#   make clangd  — write a local .clangd pointing at the resolved toolchain
#   make clean   — remove build artifacts
#
# This is the build *frontend*: it orchestrates two independent
# compilers — clang for the BPF objects, esbuild for the JS bundle.
# Neither understands the other; the JS references compiled objects in
# bin/ only by path, resolved at runtime. `yeet run` invokes `make`
# automatically when running this project from a trusted remote source,
# so the default goal must leave the project runnable.
#
# clang, bpftool and esbuild come from the static toolchain resolved by
# build/toolchain.mk (a shared per-machine cache, or binaries vendored in
# the bootstrap repo) — so the build needs no system C/BPF toolchain.

.DEFAULT_GOAL := all

include build/toolchain.mk
include build/bpf.mk

NPM ?= npm

all: bpf bundle

# Bundle the entry with the vendored esbuild. esbuild inlines node_modules
# and honors tsconfig `paths` (so `@/` resolves at bundle time), while
# `yeet:*` builtins and `*.bpf.o` objects stay external. The bundle is
# written to src/index.jsx, which the entry ladder prefers over src/main.jsx
# — so once built, that is what runs. The .jsx extension keeps the bundle
# eligible for component auto-mount. Compiled BPF objects in bin/ are loaded
# by path at runtime, never imported, so they are not bundled.
#
# `npm install` still runs first: esbuild resolves the project's own
# dependencies out of node_modules when inlining them.
ESBUILD_FLAGS := --bundle --format=esm --platform=neutral \
	--main-fields=module,main --conditions=import,module \
	--outfile=src/index.jsx --jsx=automatic --jsx-import-source=yeet:tui

bundle: node_modules | toolchain
	$(ESBUILD) src/main.jsx $(ESBUILD_FLAGS) '--external:yeet:*' '--external:*.bpf.o'

node_modules: package.json
	$(NPM) install
	@touch node_modules

# Post-generation finalize: initialize a git repository with the vendored git
# (fetched via `vendored-git`). Idempotent — skipped if this is already a repo.
# The scaffolders (`yeet new`, `scripts/new`) run `make postgen` after creating
# the project, so the CLI itself stays a thin caller of make.
postgen: | vendored-git
	@g="$(GIT)"; [ -x "$$g" ] || g="$$(command -v git 2>/dev/null || true)"; \
	if [ -e .git ]; then \
		echo "postgen: already a git repository"; \
	elif [ -n "$$g" ]; then \
		echo "postgen: git init"; \
		"$$g" -c init.templateDir= init -q . || echo "warning: 'git init' failed" >&2; \
	else \
		echo "warning: no git available (vendored or host); skipping 'git init'" >&2; \
	fi

clean: clean-bpf
	rm -rf node_modules dist src/index.jsx

.PHONY: all bundle clean postgen
