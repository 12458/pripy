import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const JSON_ACCEPT = "application/vnd.pypi.simple.v1+json";
const TOKEN = "test-token";

async function call(
	method: string,
	path: string,
	opts: { accept?: string; auth?: string | false; body?: BodyInit; headers?: Record<string, string> } = {},
) {
	const headers: Record<string, string> = {};
	if (opts.accept) headers["Accept"] = opts.accept;
	const auth = opts.auth === undefined ? TOKEN : opts.auth;
	if (auth) headers["Authorization"] = `Bearer ${auth}`;
	if (opts.headers) Object.assign(headers, opts.headers);

	const request = new IncomingRequest(`http://localhost${path}`, {
		method,
		headers,
		body: opts.body ?? (method === "PUT" ? new ArrayBuffer(0) : undefined),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function upload(project: string, filename: string, body: string = "fake-package-data") {
	return call("PUT", `/packages/${project}/${filename}`, {
		auth: TOKEN,
		body: new TextEncoder().encode(body),
	});
}

describe("pripy", () => {
	// Clean R2 bucket between tests
	beforeEach(async () => {
		const listed = await env.BUCKET.list();
		if (listed.objects.length > 0) {
			await env.BUCKET.delete(listed.objects.map((o) => o.key));
		}
	});

	describe("content negotiation", () => {
		it("returns 406 for /simple/ without proper Accept header", async () => {
			const res = await call("GET", "/simple/");
			expect(res.status).toBe(406);
		});

		it("returns 406 for /simple/<project>/ without proper Accept header", async () => {
			const res = await call("GET", "/simple/my-pkg/");
			expect(res.status).toBe(406);
		});

		it("accepts application/vnd.pypi.simple.v1+json", async () => {
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			expect(res.status).toBe(200);
		});

		it("accepts */*", async () => {
			const res = await call("GET", "/simple/", { accept: "*/*" });
			expect(res.status).toBe(200);
		});
	});

	describe("root index", () => {
		it("returns empty project list initially", async () => {
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			expect(res.status).toBe(200);
			const data = await res.json() as any;
			expect(data.meta["api-version"]).toBe("1.1");
			expect(data.projects).toEqual([]);
		});

		it("lists projects after upload", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl");
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.projects).toEqual([{ name: "my-pkg" }]);
		});

		it("has correct content-type", async () => {
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			expect(res.headers.get("Content-Type")).toContain(JSON_ACCEPT);
		});
	});

	describe("project index", () => {
		it("returns 404 for unknown project", async () => {
			const res = await call("GET", "/simple/nonexistent/", { accept: JSON_ACCEPT });
			expect(res.status).toBe(404);
		});

		it("returns project details after upload", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl");
			const res = await call("GET", "/simple/my-pkg/", { accept: JSON_ACCEPT });
			expect(res.status).toBe(200);
			const data = await res.json() as any;
			expect(data.name).toBe("my-pkg");
			expect(data.versions).toEqual(["1.0.0"]);
			expect(data.files).toHaveLength(1);
			expect(data.files[0].filename).toBe("my_pkg-1.0.0-py3-none-any.whl");
			expect(data.files[0].hashes.sha256).toBeTruthy();
			expect(data.files[0].size).toBeGreaterThan(0);
			expect(data.files[0]["upload-time"]).toBeTruthy();
		});

		it("includes requires-python when provided", async () => {
			const res = await call("PUT", "/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl", {
				auth: TOKEN,
				body: new TextEncoder().encode("data"),
				headers: { "X-Requires-Python": ">=3.8" },
			});
			expect(res.status).toBe(201);

			const idx = await call("GET", "/simple/my-pkg/", { accept: JSON_ACCEPT });
			const data = await idx.json() as any;
			expect(data.files[0]["requires-python"]).toBe(">=3.8");
		});
	});

	describe("name normalization", () => {
		it("normalizes project names with dots, underscores, mixed case", async () => {
			await upload("My_Package.Name", "my_package_name-1.0.0-py3-none-any.whl");
			// Access with different casing/separators
			const res = await call("GET", "/simple/my-package-name/", { accept: JSON_ACCEPT });
			expect(res.status).toBe(200);
			const data = await res.json() as any;
			expect(data.name).toBe("my-package-name");
		});
	});

	describe("PEP 440 version normalization", () => {
		it("normalizes pre-release spelling", async () => {
			await upload("pkg", "pkg-1.0alpha1-py3-none-any.whl");
			await upload("pkg", "pkg-2.0Beta2-py3-none-any.whl");
			await upload("pkg", "pkg-3.0C1-py3-none-any.whl");
			await upload("pkg", "pkg-4.0preview3-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0a1", "2.0b2", "3.0rc1", "4.0rc3"]);
		});

		it("normalizes post-release forms", async () => {
			await upload("pkg", "pkg-1.0.post1-py3-none-any.whl");
			await upload("pkg", "pkg-2.0.rev2-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0.post1", "2.0.post2"]);
		});

		it("normalizes dev releases", async () => {
			await upload("pkg", "pkg-1.0.dev3-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0.dev3"]);
		});

		it("strips leading v and normalizes leading zeros", async () => {
			await upload("pkg", "pkg-v01.02.03-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.2.3"]);
		});

		it("handles epoch", async () => {
			await upload("pkg", "pkg-1!2.0-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1!2.0"]);
		});

		it("normalizes local version separators", async () => {
			await upload("pkg", "pkg-1.0+local_build.1-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0+local.build.1"]);
		});

		it("normalizes implicit pre-release number", async () => {
			await upload("pkg", "pkg-1.0a-py3-none-any.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0a0"]);
		});

		it("normalizes sdist versions", async () => {
			await upload("pkg", "pkg-1.0.Alpha1.tar.gz");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0a1"]);
		});

		it("deduplicates equivalent versions", async () => {
			await upload("pkg", "pkg-1.0RC1-py3-none-any.whl");
			await upload("pkg", "pkg-1.0rc1-py3-none-linux_x86_64.whl");
			const res = await call("GET", "/simple/pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0rc1"]);
			expect(data.files).toHaveLength(2);
		});
	});

	describe("auth", () => {
		it("rejects requests without auth", async () => {
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT, auth: false });
			expect(res.status).toBe(401);
		});

		it("rejects wrong token", async () => {
			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT, auth: "wrong-token" });
			expect(res.status).toBe(401);
		});

		it("accepts Basic auth (username ignored, password is token)", async () => {
			const basic = btoa(`anything:${TOKEN}`);
			const res = await call("GET", "/simple/", {
				accept: JSON_ACCEPT,
				auth: false,
				headers: { Authorization: `Basic ${basic}` },
			});
			expect(res.status).toBe(200);
		});
	});

	describe("package upload", () => {
		it("returns 201 on successful upload", async () => {
			const res = await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl");
			expect(res.status).toBe(201);
		});

		it("returns 409 when uploading duplicate filename", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl", "v1");
			const res = await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl", "v1-modified");
			expect(res.status).toBe(409);

			// Original file is unchanged
			const dl = await call("GET", "/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl");
			expect(await dl.text()).toBe("v1");
		});

		it("allows same version with different filenames", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl", "universal");
			const res = await upload("my-pkg", "my_pkg-1.0.0-cp312-cp312-linux_x86_64.whl", "linux");
			expect(res.status).toBe(201);

			const idx = await call("GET", "/simple/my-pkg/", { accept: JSON_ACCEPT });
			const data = await idx.json() as any;
			expect(data.files).toHaveLength(2);
			expect(data.versions).toEqual(["1.0.0"]);
		});

		it("handles multiple versions", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl", "v1");
			await upload("my-pkg", "my_pkg-2.0.0-py3-none-any.whl", "v2");

			const res = await call("GET", "/simple/my-pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.versions).toEqual(["1.0.0", "2.0.0"]);
			expect(data.files).toHaveLength(2);
		});
	});

	describe("package download", () => {
		it("downloads uploaded file", async () => {
			const content = "my-package-content";
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl", content);

			const res = await call("GET", "/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl");
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(content);
			expect(res.headers.get("Cache-Control")).toContain("immutable");
		});

		it("returns 404 for missing package", async () => {
			const res = await call("GET", "/packages/my-pkg/nonexistent-1.0.0.whl");
			expect(res.status).toBe(404);
		});
	});

	describe("package delete", () => {
		it("removes file from project index", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl");
			await upload("my-pkg", "my_pkg-2.0.0-py3-none-any.whl");

			const del = await call("DELETE", "/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl", { auth: TOKEN });
			expect(del.status).toBe(200);

			const res = await call("GET", "/simple/my-pkg/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.files).toHaveLength(1);
			expect(data.versions).toEqual(["2.0.0"]);
		});

		it("removes project from root index when last file deleted", async () => {
			await upload("my-pkg", "my_pkg-1.0.0-py3-none-any.whl");
			await call("DELETE", "/packages/my-pkg/my_pkg-1.0.0-py3-none-any.whl", { auth: TOKEN });

			const res = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			const data = await res.json() as any;
			expect(data.projects).toEqual([]);
		});
	});

	describe("upload + download cycle", () => {
		it("full round trip: upload, index, download, verify hash", async () => {
			const content = "full-cycle-test-content";
			await upload("test-pkg", "test_pkg-0.1.0-py3-none-any.whl", content);

			// Check root index
			const root = await call("GET", "/simple/", { accept: JSON_ACCEPT });
			const rootData = await root.json() as any;
			expect(rootData.projects).toContainEqual({ name: "test-pkg" });

			// Check project index
			const proj = await call("GET", "/simple/test-pkg/", { accept: JSON_ACCEPT });
			const projData = await proj.json() as any;
			const file = projData.files[0];
			expect(file.url).toBe("/packages/test-pkg/test_pkg-0.1.0-py3-none-any.whl");

			// Download and verify content
			const dl = await call("GET", file.url);
			expect(await dl.text()).toBe(content);

			// Verify hash matches
			const expectedHash = file.hashes.sha256;
			const encoder = new TextEncoder();
			const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(content));
			const actualHash = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
			expect(expectedHash).toBe(actualHash);
		});
	});

	describe("routing", () => {
		it("returns 404 for unknown paths", async () => {
			const res = await call("GET", "/unknown");
			expect(res.status).toBe(404);
		});

		it("returns 404 for /simple without trailing slash", async () => {
			const res = await call("GET", "/simple", { accept: JSON_ACCEPT });
			expect(res.status).toBe(404);
		});
	});
});
