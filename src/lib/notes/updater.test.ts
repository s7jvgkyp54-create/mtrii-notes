import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkForGithubUpdates } from "./updater.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub update repository transition", () => {
  it("uses the legacy public release when the current release endpoint returns 404", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/repos/mnhtis1/notes/")) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }

      return Response.json({
        tag_name: "v0.5.22",
        name: "Notes 0.5.22",
        body: "Release bridge",
        published_at: "2026-09-13T00:00:00Z",
        assets: [
          {
            name: "Notes_0.5.22_x64-setup.exe",
            size: 42,
            browser_download_url:
              "https://github.com/s7jvgkyp54-create/mtrii-notes/releases/download/v0.5.22/Notes_0.5.22_x64-setup.exe",
          },
        ],
      });
    }) as typeof fetch;

    const checked = await checkForGithubUpdates("mnhtis1/notes", "0.5.21");

    assert.equal(checked.ok, true);
    assert.equal(checked.result?.updateAvailable, true);
    assert.equal(checked.result?.latestVersion, "0.5.22");
    assert.equal(checked.result?.assetName, "Notes_0.5.22_x64-setup.exe");
    assert.equal(
      checked.result?.releaseUrl,
      "https://github.com/s7jvgkyp54-create/mtrii-notes/releases",
    );
    assert.deepEqual(calls, [
      "https://api.github.com/repos/mnhtis1/notes/releases/latest",
      "https://api.github.com/repos/s7jvgkyp54-create/mtrii-notes/releases/latest",
    ]);
  });

  it("does not redirect a user-configured repository to the legacy repository", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    const checked = await checkForGithubUpdates("someone/another-notes", "0.5.21");

    assert.equal(checked.ok, false);
    assert.match(checked.message ?? "", /someone\/another-notes/);
    assert.deepEqual(calls, ["https://api.github.com/repos/someone/another-notes/releases/latest"]);
  });

  it("never offers a non-exe release asset as a direct Windows update", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        tag_name: "v0.5.22",
        name: "Notes 0.5.22",
        assets: [
          {
            name: "source-code.zip",
            size: 42,
            browser_download_url: "https://example.test/source-code.zip",
          },
        ],
      })) as typeof fetch;

    const checked = await checkForGithubUpdates("mnhtis1/notes", "0.5.21");

    assert.equal(checked.ok, true);
    assert.equal(checked.result?.updateAvailable, true);
    assert.equal(checked.result?.downloadUrl, null);
    assert.equal(checked.result?.assetName, null);
    assert.equal(checked.result?.assetSize, null);
  });
});
