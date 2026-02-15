#!/bin/bash
# Wrapper script to run tests via vitest
# Usage: ./scripts/test.sh [vitest args...]

exec vitest "$@"
