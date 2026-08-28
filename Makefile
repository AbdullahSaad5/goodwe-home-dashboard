.PHONY: setup test lint format build

setup:
	./setup.sh

test:
	.venv/bin/pytest
	npm test

lint:
	.venv/bin/ruff check server
	.venv/bin/ruff format --check server
	npm run lint
	npm run format:check

format:
	.venv/bin/ruff check --fix server
	.venv/bin/ruff format server
	npm run format

build:
	npm run build
