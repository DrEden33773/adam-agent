import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export type LocalNpmRegistryFixture = {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
};

export type HeldLocalNpmRegistryFixture = LocalNpmRegistryFixture & {
  readonly requestReceived: Promise<void>;
  readonly requestClosed: Promise<void>;
};

export type GatedLocalNpmRegistryFixture = LocalNpmRegistryFixture & {
  readonly requestReceived: Promise<void>;
  release(): void;
};

export async function createHeldLocalNpmRegistryFixture(): Promise<HeldLocalNpmRegistryFixture> {
  const requests: string[] = [];
  let resolveRequestReceived!: () => void;
  let resolveRequestClosed!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequestReceived = resolve;
  });
  const requestClosed = new Promise<void>((resolve) => {
    resolveRequestClosed = resolve;
  });
  const server = createServer((request) => {
    requests.push(request.url ?? "/");
    resolveRequestReceived();
    request.once("close", resolveRequestClosed);
  });
  await listenLocal(server);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestReceived,
    requestClosed,
    close: () => closeServer(server),
  };
}

export async function createLocalNpmRegistryFixture(input: {
  readonly packageName: string;
  readonly version: string;
  readonly binName: string;
  readonly binSourcePath: string;
  readonly lifecycleMarker?: string;
}): Promise<LocalNpmRegistryFixture> {
  return createLocalNpmRegistryFixtureImpl(input);
}

export async function createGatedLocalNpmRegistryFixture(input: {
  readonly packageName: string;
  readonly version: string;
  readonly binName: string;
  readonly binSourcePath: string;
  readonly lifecycleMarker?: string;
}): Promise<GatedLocalNpmRegistryFixture> {
  let announceRequest!: () => void;
  let releaseResponses!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    announceRequest = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const fixture = await createLocalNpmRegistryFixtureImpl(input, async () => {
    announceRequest();
    await released;
  });
  return { ...fixture, requestReceived, release: releaseResponses };
}

async function createLocalNpmRegistryFixtureImpl(
  input: {
    readonly packageName: string;
    readonly version: string;
    readonly binName: string;
    readonly binSourcePath: string;
    readonly lifecycleMarker?: string;
  },
  beforeResponse?: () => Promise<void>,
): Promise<LocalNpmRegistryFixture> {
  const packageJson = Buffer.from(
    JSON.stringify({
      name: input.packageName,
      version: input.version,
      type: "module",
      bin: { [input.binName]: "bin/server.js" },
      ...(input.lifecycleMarker === undefined
        ? {}
        : {
            scripts: {
              install: `node -e "require('node:fs').writeFileSync(${JSON.stringify(
                input.lifecycleMarker,
              )}, 'ran')"`,
            },
          }),
    }),
  );
  const binSource = Buffer.concat([
    Buffer.from("#!/usr/bin/env node\n"),
    await readFile(input.binSourcePath),
  ]);
  const tarball = gzipSync(
    createTarArchive([
      { name: "package/package.json", bytes: packageJson, mode: 0o644 },
      { name: "package/bin/server.js", bytes: binSource, mode: 0o755 },
    ]),
    { level: 9 },
  );
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const shasum = createHash("sha1").update(tarball).digest("hex");
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const requestUrl = request.url ?? "/";
    requests.push(requestUrl);
    await beforeResponse?.();
    if (requestUrl.endsWith("/package.tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarball);
      return;
    }
    const address = server.address() as AddressInfo;
    const registryUrl = `http://127.0.0.1:${address.port}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: input.packageName,
        "dist-tags": { latest: input.version },
        versions: {
          [input.version]: {
            name: input.packageName,
            version: input.version,
            type: "module",
            bin: { [input.binName]: "bin/server.js" },
            dist: {
              tarball: `${registryUrl}/package.tgz`,
              integrity,
              shasum,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

export async function createForeignTransitiveNpmRegistryFixture(input: {
  readonly packageName: string;
  readonly version: string;
  readonly binName: string;
  readonly binSourcePath: string;
  readonly dependencyPackageName: string;
  readonly dependencyVersion: string;
}): Promise<LocalNpmRegistryFixture> {
  const dependencyPackageJson = Buffer.from(
    JSON.stringify({
      name: input.dependencyPackageName,
      version: input.dependencyVersion,
    }),
  );
  const dependencyTarball = gzipSync(
    createTarArchive([{ name: "package/package.json", bytes: dependencyPackageJson, mode: 0o644 }]),
    { level: 9 },
  );
  const dependencyIntegrity = `sha512-${createHash("sha512")
    .update(dependencyTarball)
    .digest("base64")}`;
  const dependencyShasum = createHash("sha1").update(dependencyTarball).digest("hex");
  const requests: string[] = [];
  const foreignServer = createServer((request, response) => {
    requests.push(`foreign:${request.url ?? "/"}`);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(dependencyTarball);
  });
  await listenLocal(foreignServer);
  const foreignAddress = foreignServer.address() as AddressInfo;
  const foreignTarballUrl = `http://127.0.0.1:${foreignAddress.port}/dependency.tgz`;

  const packageJson = Buffer.from(
    JSON.stringify({
      name: input.packageName,
      version: input.version,
      type: "module",
      bin: { [input.binName]: "bin/server.js" },
      dependencies: { [input.dependencyPackageName]: input.dependencyVersion },
    }),
  );
  const binSource = Buffer.concat([
    Buffer.from("#!/usr/bin/env node\n"),
    await readFile(input.binSourcePath),
  ]);
  const packageTarball = gzipSync(
    createTarArchive([
      { name: "package/package.json", bytes: packageJson, mode: 0o644 },
      { name: "package/bin/server.js", bytes: binSource, mode: 0o755 },
    ]),
    { level: 9 },
  );
  const packageIntegrity = `sha512-${createHash("sha512").update(packageTarball).digest("base64")}`;
  const packageShasum = createHash("sha1").update(packageTarball).digest("hex");

  const server = createServer((request, response) => {
    const requestUrl = request.url ?? "/";
    requests.push(requestUrl);
    if (requestUrl.endsWith("/package.tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(packageTarball);
      return;
    }
    const address = server.address() as AddressInfo;
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const decodedUrl = decodeURIComponent(requestUrl).toLowerCase();
    const dependencyRequest = decodedUrl.includes(input.dependencyPackageName.toLowerCase());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      dependencyRequest
        ? JSON.stringify({
            name: input.dependencyPackageName,
            "dist-tags": { latest: input.dependencyVersion },
            versions: {
              [input.dependencyVersion]: {
                name: input.dependencyPackageName,
                version: input.dependencyVersion,
                dist: {
                  tarball: foreignTarballUrl,
                  integrity: dependencyIntegrity,
                  shasum: dependencyShasum,
                },
              },
            },
          })
        : JSON.stringify({
            name: input.packageName,
            "dist-tags": { latest: input.version },
            versions: {
              [input.version]: {
                name: input.packageName,
                version: input.version,
                type: "module",
                bin: { [input.binName]: "bin/server.js" },
                dependencies: { [input.dependencyPackageName]: input.dependencyVersion },
                dist: {
                  tarball: `${registryUrl}/package.tgz`,
                  integrity: packageIntegrity,
                  shasum: packageShasum,
                },
              },
            },
          }),
    );
  });
  try {
    await listenLocal(server);
  } catch (error) {
    await closeServer(foreignServer);
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await Promise.all([closeServer(server), closeServer(foreignServer)]);
    },
  };
}

function createTarArchive(
  entries: readonly { readonly name: string; readonly bytes: Buffer; readonly mode: number }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeText(header, 257, 6, "ustar");
    writeText(header, 263, 2, "00");
    const checksum = header.reduce((total, byte) => total + byte, 0);
    const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
    writeText(header, 148, 8, checksumText);
    chunks.push(header, entry.bytes);
    const remainder = entry.bytes.byteLength % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks);
}

function listenLocal(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  writeText(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}
