import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { scratchDirectory } from "./scratch-repository";

/**
 * A proxy that answers HTTPS requests to one host itself, as a sandbox's proxy does. It accepts
 * each CONNECT, and answers inside the tunnel with a self-signed certificate for the host.
 */
export interface InterceptingProxy {
  /** The proxy's certificate, in PEM, which a client trusts as its certificate authority. */
  readonly ca: string;
  /** A file holding `ca`. */
  readonly caFile: string;
  readonly url: string;
}

/** A request the proxy received inside a tunnel. */
export interface InterceptedRequest {
  readonly method: string;
  readonly path: string;
}

// Each host's certificate and key, made once per run, since openssl takes a while.
const certificates = new Map<string, { readonly cert: string; readonly key: string }>();

const certificateFor = (host: string) => {
  let made = certificates.get(host);
  if (made === undefined) {
    const directory = scratchDirectory("certificate-");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "key.pem",
        "-out",
        "cert.pem",
        "-days",
        "1",
        "-subj",
        `/CN=${host}`,
        "-addext",
        `subjectAltName=DNS:${host}`,
      ],
      { cwd: directory, stdio: "ignore" },
    );
    const read = (file: string) => readFileSync(path.join(directory, file), "utf8");
    made = { cert: read("cert.pem"), key: read("key.pem") };
    certificates.set(host, made);
  }
  return made;
};

// Listens on a free port of the loopback address, and returns the port.
const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`expected a TCP address, got ${String(address)}`));
      } else {
        resolve(address.port);
      }
    });
  });

const closed = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

/**
 * Runs `run` against a proxy that answers each request to the host with the JSON `respond`
 * returns. Returns its result, and each CONNECT and request the proxy received, in order, as
 * `CONNECT host:port` or `GET host/path`.
 */
export const throughProxy = async <A>(
  host: string,
  respond: (request: InterceptedRequest) => unknown,
  run: (proxy: InterceptingProxy) => Promise<A>,
): Promise<{ readonly log: readonly string[]; readonly result: A }> => {
  const { cert, key } = certificateFor(host);
  const caFile = path.join(scratchDirectory("proxy-"), "ca.pem");
  writeFileSync(caFile, cert);
  const log: string[] = [];

  const origin = createHttpsServer({ cert, key }, (request, response) => {
    const method = request.method ?? "";
    const requestPath = request.url ?? "";
    log.push(`${method} ${request.headers.host ?? ""}${requestPath}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(respond({ method, path: requestPath })));
  });
  const port = await listen(origin);

  // The plain TCP server has no `closeAllConnections`, so its sockets are kept to close them.
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    sockets.add(client);
    client.on("close", () => {
      sockets.delete(client);
    });
    let head = "";
    // A client that rejects the certificate resets the tunnel, which is no failure of the proxy.
    client.on("error", () => {
      client.destroy();
    });
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      // Paused until `pipe` resumes it, so no bytes go by while the tunnel connects.
      client.pause();
      client.off("data", onData);
      const [method, target] = head.slice(0, head.indexOf("\r\n")).split(" ");
      log.push(`${method} ${target}`);
      const tunnel = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunnel.write(Buffer.from(head.slice(end + 4), "latin1"));
        client.pipe(tunnel).pipe(client);
      });
      tunnel.on("error", () => {
        client.destroy();
      });
    };
    client.on("data", onData);
  });
  const url = `http://127.0.0.1:${await listen(proxy)}`;

  try {
    const result = await run({ ca: cert, caFile, url });
    return { log: [...log], result };
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    origin.closeAllConnections();
    await Promise.all([closed(origin), closed(proxy)]);
  }
};
