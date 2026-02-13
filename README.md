# pripy

Private Python package registry on Cloudflare Workers + R2. JSON-only Simple Repository API targeting modern clients like `uv`.

## Setup

```bash
pnpm install

# Create the R2 bucket
npx wrangler r2 bucket create pripy

# Set the auth token (used for all requests)
npx wrangler secret put UPLOAD_TOKEN

# Deploy
npx wrangler deploy
```

## Usage

Set `TOKEN` and `URL` for the examples below:

```bash
TOKEN="your-secret-token"
URL="https://pripy.YOUR_SUBDOMAIN.workers.dev"
```

### Upload a package

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Requires-Python: >=3.8" \
  --data-binary @dist/my_pkg-1.0.0-py3-none-any.whl \
  $URL/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl
```

### Delete a package

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  $URL/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl
```

### Browse the index

```bash
# List all projects
curl -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.pypi.simple.v1+json" \
  $URL/simple/

# List files for a project
curl -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.pypi.simple.v1+json" \
  $URL/simple/my-pkg/
```

### Install with uv

```bash
uv pip install \
  --index-url https://x:$TOKEN@pripy.YOUR_SUBDOMAIN.workers.dev/simple/ \
  my-pkg
```

Or in `pyproject.toml`:

```toml
[[tool.uv.index]]
name = "pripy"
url = "https://pripy.YOUR_SUBDOMAIN.workers.dev/simple/"
```

With credentials via environment variables:

```bash
export UV_INDEX_PRIPY_USERNAME=x
export UV_INDEX_PRIPY_PASSWORD="your-secret-token"
```

### Install with pip

```bash
pip install \
  --index-url https://x:$TOKEN@pripy.YOUR_SUBDOMAIN.workers.dev/simple/ \
  my-pkg
```

## Authentication

All endpoints require authentication. Both methods are supported:

- **Basic Auth** (for pip/uv): username is ignored, password is the token
- **Bearer token** (for curl/scripts): `Authorization: Bearer <token>`

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/simple/` | Project list (JSON) |
| GET | `/simple/<project>/` | Project file listing (JSON) |
| GET | `/packages/<project>/<filename>` | Download package |
| PUT | `/packages/<project>/<filename>` | Upload package |
| DELETE | `/packages/<project>/<filename>` | Delete package |

`/simple/` endpoints require `Accept: application/vnd.pypi.simple.v1+json` (or `*/*`).

Implements [Simple Repository API v1.1](https://peps.python.org/pep-0700/) with `versions`, `size`, and `upload-time` fields. Version strings are normalized per [PEP 440](https://peps.python.org/pep-0440/).

## R2 storage layout

```
simple/index.json                         # root project list
simple/<normalized-project>/index.json    # per-project file listing
packages/<normalized-project>/<filename>  # .whl / .tar.gz files
```

## Caching

| Resource | Cache-Control | Notes |
|----------|--------------|-------|
| `/simple/` | `max-age=600` | Invalidated on upload/delete |
| `/simple/<project>/` | `max-age=600` | Invalidated on upload/delete |
| `/packages/...` | `max-age=31536000, immutable` | Never changes |

## Development

```bash
# Run locally (emulated R2, no Cloudflare account needed)
npx wrangler dev

# Run tests
pnpm test

# Regenerate types after wrangler.jsonc changes
npx wrangler types
```
