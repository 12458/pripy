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

### Yank a file

```bash
# Yank with a reason
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": "security vulnerability"}' \
  $URL/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl

# Unyank
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": false}' \
  $URL/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl
```

### Set project status

```bash
# Archive a project (blocks further uploads)
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project-status": {"status": "archived", "reason": "no longer maintained"}}' \
  $URL/simple/my-pkg/

# Clear status (back to active)
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project-status": null}' \
  $URL/simple/my-pkg/
```

Supported statuses: `active` (default), `archived`, `quarantined`, `deprecated`.

### Upload provenance attestations

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @provenance.json \
  $URL/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl.provenance
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/simple/` | Project list (JSON) |
| GET | `/simple/<project>/` | Project file listing (JSON) |
| PATCH | `/simple/<project>/` | Set project status |
| GET | `/packages/<project>/<filename>` | Download package |
| PUT | `/packages/<project>/<filename>` | Upload package |
| DELETE | `/packages/<project>/<filename>` | Delete package |
| PATCH | `/packages/<project>/<filename>` | Yank/unyank a file |
| GET | `/packages/<project>/<filename>.provenance` | Download provenance |
| PUT | `/packages/<project>/<filename>.provenance` | Upload provenance |

`/simple/` endpoints require `Accept: application/vnd.pypi.simple.v1+json` (or `*/*`).

Implements [Simple Repository API v1.4](https://packaging.python.org/en/latest/specifications/simple-repository-api/) with:

- **v1.1**: `versions`, `size`, `upload-time` fields ([PEP 700](https://peps.python.org/pep-0700/))
- **v1.2**: File yanking ([PEP 592](https://peps.python.org/pep-0592/))
- **v1.3**: Index-hosted attestations / provenance ([PEP 740](https://peps.python.org/pep-0740/))
- **v1.4**: Project status markers ([PEP 792](https://peps.python.org/pep-0792/))

Version strings are normalized per [PEP 440](https://peps.python.org/pep-0440/).

## R2 storage layout

```
simple/index.json                                    # root project list
simple/<normalized-project>/index.json               # per-project file listing
packages/<normalized-project>/<filename>             # .whl / .tar.gz files
packages/<normalized-project>/<filename>.provenance  # provenance attestations
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
