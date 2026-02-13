import { createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/vnd.pypi.simple.v1+json";

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function acceptsJson(request: Request): boolean {
	const accept = request.headers.get("Accept") ?? "";
	return accept.includes(JSON_CONTENT_TYPE) || accept.includes("*/*");
}

function jsonResponse(data: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": `${JSON_CONTENT_TYPE}; charset=utf-8`,
			...headers,
		},
	});
}

function notAcceptable(): Response {
	return new Response("Not Acceptable: use Accept: application/vnd.pypi.simple.v1+json", { status: 406 });
}

function unauthorized(): Response {
	return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Basic" } });
}

function checkAuth(request: Request, token: string): boolean {
	const auth = request.headers.get("Authorization") ?? "";
	if (auth === `Bearer ${token}`) return true;
	if (auth.startsWith("Basic ")) {
		const [, password] = atob(auth.slice(6)).split(":");
		return password === token;
	}
	return false;
}

function notFound(): Response {
	return new Response("Not Found", { status: 404 });
}

interface ProjectIndex {
	meta: { "api-version": string };
	name: string;
	versions: string[];
	files: {
		filename: string;
		url: string;
		hashes: { sha256: string };
		"requires-python"?: string;
		size: number;
		"upload-time": string;
	}[];
}

interface RootIndex {
	meta: { "api-version": string };
	projects: { name: string }[];
}

// PEP 440 version pattern (permissive, for parsing + normalization)
const VERSION_RE = new RegExp(
	[
		"^",
		"v?",
		"(?:(?<epoch>[0-9]+)!)?",
		"(?<release>[0-9]+(?:\\.[0-9]+)*)",
		"(?<pre>[-_.]?(?<pre_l>alpha|beta|preview|pre|a|b|c|rc)[-_.]?(?<pre_n>[0-9]*))?",
		"(?:(?<post1>-(?<post_n1>[0-9]+))|(?<post2>[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]*)))?",
		"(?<dev>[-_.]?dev[-_.]?(?<dev_n>[0-9]*))?",
		"(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?",
		"$",
	].join(""),
	"i",
);

const PRE_SPELLING: Record<string, string> = {
	alpha: "a",
	beta: "b",
	preview: "rc",
	pre: "rc",
	c: "rc",
	a: "a",
	b: "b",
	rc: "rc",
};

function normalizeVersion(v: string): string {
	const m = v.trim().match(VERSION_RE);
	if (!m || !m.groups) return v;
	const g = m.groups;

	// Release segment: strip leading zeros from each component
	const release = g.release
		.split(".")
		.map((s) => String(parseInt(s, 10)))
		.join(".");

	let result = "";
	if (g.epoch && g.epoch !== "0") result += `${parseInt(g.epoch, 10)}!`;
	result += release;

	// Pre-release
	if (g.pre_l) {
		const label = PRE_SPELLING[g.pre_l.toLowerCase()];
		const num = g.pre_n ? parseInt(g.pre_n, 10) : 0;
		result += `${label}${num}`;
	}

	// Post-release
	if (g.post_n1 !== undefined) {
		result += `.post${parseInt(g.post_n1, 10)}`;
	} else if (g.post_l) {
		const num = g.post_n2 ? parseInt(g.post_n2, 10) : 0;
		result += `.post${num}`;
	}

	// Dev release
	if (g.dev !== undefined && g.dev !== "") {
		const num = g.dev_n ? parseInt(g.dev_n, 10) : 0;
		result += `.dev${num}`;
	}

	// Local
	if (g.local) {
		result += `+${g.local.toLowerCase().replace(/[-_]/g, ".")}`;
	}

	return result;
}

function extractVersion(filename: string): string {
	let raw: string;
	// wheel: name-version-pytag-abitag-platform.whl
	if (filename.endsWith(".whl")) {
		const parts = filename.split("-");
		raw = parts.length >= 2 ? parts[1] : "0.0.0";
	} else {
		// sdist: name-version.tar.gz or name-version.zip
		let stripped = filename;
		for (const ext of [".tar.gz", ".tar.bz2", ".zip", ".tar.xz"]) {
			if (stripped.endsWith(ext)) {
				stripped = stripped.slice(0, -ext.length);
				break;
			}
		}
		const lastDash = stripped.lastIndexOf("-");
		raw = lastDash !== -1 ? stripped.slice(lastDash + 1) : "0.0.0";
	}
	return normalizeVersion(raw);
}

async function streamSha256(stream: ReadableStream<Uint8Array>): Promise<string> {
	const hasher = createHash("sha256");
	for await (const chunk of stream) {
		hasher.update(chunk);
	}
	return hasher.digest("hex");
}

async function getRootIndex(bucket: R2Bucket): Promise<RootIndex> {
	const obj = await bucket.get("simple/index.json");
	if (obj) {
		return obj.json();
	}
	return { meta: { "api-version": "1.1" }, projects: [] };
}

async function getProjectIndex(bucket: R2Bucket, normalized: string): Promise<ProjectIndex | null> {
	const obj = await bucket.get(`simple/${normalized}/index.json`);
	if (obj) {
		return obj.json();
	}
	return null;
}

async function putProjectIndex(bucket: R2Bucket, normalized: string, index: ProjectIndex): Promise<void> {
	await bucket.put(`simple/${normalized}/index.json`, JSON.stringify(index));
}

async function putRootIndex(bucket: R2Bucket, index: RootIndex): Promise<void> {
	await bucket.put("simple/index.json", JSON.stringify(index));
}

async function invalidateCache(cache: Cache, url: URL, paths: string[]): Promise<void> {
	for (const path of paths) {
		const cacheUrl = new URL(path, url.origin);
		await cache.delete(new Request(cacheUrl.toString()));
	}
}

// --- Route handlers ---

async function handleRootIndex(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!acceptsJson(request)) return notAcceptable();

	const cache = caches.default;
	const cacheKey = new Request(new URL("/simple/", request.url).toString());
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const index = await getRootIndex(env.BUCKET);
	const response = jsonResponse(index, { "Cache-Control": "public, max-age=600" });

	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function handleProjectIndex(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	project: string,
): Promise<Response> {
	if (!acceptsJson(request)) return notAcceptable();

	const normalized = normalizeName(project);
	const cache = caches.default;
	const cacheKey = new Request(new URL(`/simple/${normalized}/`, request.url).toString());
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const index = await getProjectIndex(env.BUCKET, normalized);
	if (!index) return notFound();

	const response = jsonResponse(index, { "Cache-Control": "public, max-age=600" });
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function handlePackageDownload(env: Env, project: string, filename: string): Promise<Response> {
	const normalized = normalizeName(project);
	const obj = await env.BUCKET.get(`packages/${normalized}/${filename}`);
	if (!obj) return notFound();

	return new Response(obj.body, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Length": obj.size.toString(),
			"Cache-Control": "public, max-age=31536000, immutable",
			ETag: obj.httpEtag,
		},
	});
}

async function handlePackageUpload(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	project: string,
	filename: string,
): Promise<Response> {
	const normalized = normalizeName(project);
	const { body } = request;
	if (!body) return new Response("Missing body", { status: 400 });

	// Immutability check: reject if filename already exists
	const existing = await env.BUCKET.head(`packages/${normalized}/${filename}`);
	if (existing) {
		return new Response("File already exists. Releases are immutable.", { status: 409 });
	}

	const version = extractVersion(filename);
	const requiresPython = request.headers.get("X-Requires-Python") ?? undefined;
	const uploadTime = new Date().toISOString();

	// Tee the stream: one for R2, one for hashing
	const [r2Stream, hashStream] = body.tee();

	// Stream to R2 and compute hash concurrently
	const [r2Obj, hash] = await Promise.all([
		env.BUCKET.put(`packages/${normalized}/${filename}`, r2Stream, {
			httpMetadata: { contentType: "application/octet-stream" },
		}),
		streamSha256(hashStream),
	]);

	// Update project index
	let projectIndex = await getProjectIndex(env.BUCKET, normalized);
	let isNewProject = false;

	if (!projectIndex) {
		isNewProject = true;
		projectIndex = {
			meta: { "api-version": "1.1" },
			name: normalized,
			versions: [],
			files: [],
		};
	}

	projectIndex.files.push({
		filename,
		url: `/packages/${normalized}/${filename}`,
		hashes: { sha256: hash },
		...(requiresPython ? { "requires-python": requiresPython } : {}),
		size: r2Obj.size,
		"upload-time": uploadTime,
	});

	if (!projectIndex.versions.includes(version)) {
		projectIndex.versions.push(version);
		projectIndex.versions.sort();
	}

	await putProjectIndex(env.BUCKET, normalized, projectIndex);

	// Update root index if new project
	if (isNewProject) {
		const rootIndex = await getRootIndex(env.BUCKET);
		if (!rootIndex.projects.some((p) => p.name === normalized)) {
			rootIndex.projects.push({ name: normalized });
			rootIndex.projects.sort((a, b) => a.name.localeCompare(b.name));
			await putRootIndex(env.BUCKET, rootIndex);
		}
	}

	// Invalidate caches
	const url = new URL(request.url);
	ctx.waitUntil(invalidateCache(caches.default, url, ["/simple/", `/simple/${normalized}/`]));

	return new Response("OK", { status: 201 });
}

async function handlePackageDelete(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	project: string,
	filename: string,
): Promise<Response> {
	const normalized = normalizeName(project);

	// Delete the package file
	await env.BUCKET.delete(`packages/${normalized}/${filename}`);

	// Update project index
	const projectIndex = await getProjectIndex(env.BUCKET, normalized);
	if (projectIndex) {
		projectIndex.files = projectIndex.files.filter((f) => f.filename !== filename);

		// Recalculate versions from remaining files
		const remainingVersions = new Set(projectIndex.files.map((f) => extractVersion(f.filename)));
		projectIndex.versions = Array.from(remainingVersions).sort();

		if (projectIndex.files.length === 0) {
			// Remove empty project
			await env.BUCKET.delete(`simple/${normalized}/index.json`);
			const rootIndex = await getRootIndex(env.BUCKET);
			rootIndex.projects = rootIndex.projects.filter((p) => p.name !== normalized);
			await putRootIndex(env.BUCKET, rootIndex);
		} else {
			await putProjectIndex(env.BUCKET, normalized, projectIndex);
		}
	}

	// Invalidate caches
	const url = new URL(request.url);
	ctx.waitUntil(invalidateCache(caches.default, url, ["/simple/", `/simple/${normalized}/`]));

	return new Response("OK", { status: 200 });
}

// --- Router ---

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!checkAuth(request, env.UPLOAD_TOKEN)) return unauthorized();

		const url = new URL(request.url);
		const path = url.pathname;

		// GET /simple/ - root index
		if (path === "/simple/" && request.method === "GET") {
			return handleRootIndex(request, env, ctx);
		}

		// GET /simple/<project>/ - project index
		const projectMatch = path.match(/^\/simple\/([^/]+)\/$/);
		if (projectMatch && request.method === "GET") {
			return handleProjectIndex(request, env, ctx, projectMatch[1]);
		}

		// /packages/<project>/<filename>
		const packageMatch = path.match(/^\/packages\/([^/]+)\/([^/]+)$/);
		if (packageMatch) {
			const [, project, filename] = packageMatch;
			if (request.method === "GET") {
				return handlePackageDownload(env, project, filename);
			}
			if (request.method === "PUT") {
				return handlePackageUpload(request, env, ctx, project, filename);
			}
			if (request.method === "DELETE") {
				return handlePackageDelete(request, env, ctx, project, filename);
			}
		}

		return notFound();
	},
} satisfies ExportedHandler<Env>;
