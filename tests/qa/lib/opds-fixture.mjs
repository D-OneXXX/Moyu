import http from "node:http";
import { makePng, makeZip } from "./fixtures.mjs";

/**
 * Isolated OPDS 1.2 fixture for acceptance coverage.
 *
 * - Komga-shaped catalog guarded by Basic auth;
 * - Kavita-shaped catalog with the API key in the path (no Basic header);
 * - stored-method CBR/RAR chapters, including an encrypted archive;
 * - a second origin used to prove redirect/feed links never reach it;
 * - request accounting so the suite can assert credentials never leave the
 *   configured origin.
 *
 * No external network is used: both servers bind 127.0.0.1 on an ephemeral
 * port and are closed by `close()`.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function vint(value) {
  const out = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return Buffer.from(out);
}

function rarFinish(content) {
  const size = vint(content.length);
  const crc = crc32(Buffer.concat([size, content]));
  return Buffer.concat([u32le(crc), size, content]);
}

function rarHeader(kind, flags, body) {
  return rarFinish(Buffer.concat([vint(kind), vint(flags), body]));
}

function rarFileHeader(name, data, { unpacked = data.length, commonExtra = 0 } = {}) {
  const nameBytes = Buffer.from(name, "utf8");
  const fileFlags = 0x0004; // CRC32 present
  const body = Buffer.concat([
    vint(fileFlags),
    vint(unpacked),
    vint(0o644),
    u32le(crc32(data)),
    vint(0), // stored
    vint(1), // Unix host
    vint(nameBytes.length),
    nameBytes,
  ]);
  return rarFinish(
    Buffer.concat([
      vint(2), // file header
      vint(0x0002 | commonExtra), // data area
      vint(data.length),
      body,
    ]),
  );
}

/** Build a valid RAR5 archive with stored (uncompressed) members. */
function storedRar5(entries) {
  const parts = [
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    rarHeader(1, 0, vint(0)),
  ];
  for (const [name, data] of entries) {
    parts.push(rarFileHeader(name, data), data);
  }
  parts.push(rarHeader(5, 0, vint(0)));
  return Buffer.concat(parts);
}

export async function startOpdsFixture(port = 0) {
  const coverOne = makePng(320, 480, [56, 168, 248]);
  const coverTwo = makePng(320, 480, [248, 168, 56]);
  const chapterPages = [
    makePng(120, 180, [40, 120, 220]),
    makePng(120, 180, [220, 120, 40]),
  ];
  const cbz = makeZip([
    ["001.png", chapterPages[0]],
    ["002.png", chapterPages[1]],
  ]);
  const cbr = storedRar5([
    ["001.png", chapterPages[0]],
    ["notes.txt", Buffer.from("ignored", "utf8")],
    ["002.png", chapterPages[1]],
  ]);
  // Header-encrypted RAR fixture from the unrar-rs test corpus. Test-only:
  // the converter must reject it with a stable code instead of trying to
  // guess a password.
  const encryptedCbr = Buffer.from(
    "UmFyIRoHAM+QcwAADQAAAAAAAADT2XQkhDIAIAAAABIAAAAD84oDbi2BA0cdMwoApIEAAC5naXRpZ25vcmWJBLqMkwZDIh85hflvJV85z+khJAZWPBJPkAbK/Nli2F/wxyMypS5txD17AEAHAA==",
    "base64",
  );
  const basicAuth = "Basic dXNlcjpwYXNz"; // user:pass
  const atom = {
    "content-type": "application/atom+xml; charset=utf-8",
    "cache-control": "no-store",
  };

  const stats = {
    requests: [],
    crossOriginRequests: 0,
    basicAuthRequests: 0,
    kavitaRequests: 0,
    kavitaAuthorization: 0,
  };

  const crossOrigin = http.createServer((request, response) => {
    stats.crossOriginRequests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`leaked ${request.url}`);
  });
  await new Promise((resolve) => crossOrigin.listen(0, "127.0.0.1", resolve));
  const crossOriginOrigin = `http://127.0.0.1:${crossOrigin.address().port}`;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const authorization = request.headers.authorization ?? null;
    stats.requests.push({ path: url.pathname, authorization });
    if (url.pathname.startsWith("/api/opds/")) {
      stats.kavitaRequests += 1;
      if (authorization) stats.kavitaAuthorization += 1;
    }

    // ---------- Komga-shaped catalog (Basic auth) ----------
    if (url.pathname.startsWith("/opds/")) {
      if (authorization !== basicAuth) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("auth required");
        return;
      }
      stats.basicAuthRequests += 1;
    }
    if (url.pathname === "/opds/v1.2/catalog") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Komga Catalog</title>
        <entry><title>QA Library One</title><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/opds/v1.2/libraries/one"/></entry>
        <entry><title>QA Library Two</title><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/opds/v1.2/libraries/two"/></entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/opds/v1.2/libraries/one" && !url.searchParams.has("page")) {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Library One</title>
        <entry>
          <title>QA Chapter 001</title>
          <link rel="http://opds-spec.org/image/thumbnail" type="image/png" href="/opds/covers/one.png"/>
          <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/opds/books/one.cbz"/>
        </entry>
        <entry>
          <title>QA Chapter 002</title>
          <link rel="http://opds-spec.org/image" type="image/png" href="/opds/covers/two.png"/>
          <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/opds/books/two.cbz"/>
        </entry>
        <link rel="next" href="/opds/v1.2/libraries/one?page=2"/>
      </feed>`);
      return;
    }
    if (url.pathname === "/opds/v1.2/libraries/one" && url.searchParams.get("page") === "2") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Library One · Page 2</title>
        <entry><title>QA Chapter 003</title><link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/opds/books/one.cbz"/></entry>
        <link rel="prev" href="/opds/v1.2/libraries/one"/>
      </feed>`);
      return;
    }
    if (url.pathname === "/opds/v1.2/libraries/two") {
      response.writeHead(200, atom);
      response.end(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>QA Library Two</title><entry><title>QA Empty Series</title></entry></feed>`,
      );
      return;
    }
    if (url.pathname === "/opds/covers/one.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(coverOne);
      return;
    }
    if (url.pathname === "/opds/covers/two.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(coverTwo);
      return;
    }
    if (url.pathname === "/opds/books/one.cbz" || url.pathname === "/opds/books/two.cbz") {
      response.writeHead(200, {
        "content-type": "application/vnd.comicbook+zip",
        "content-length": String(cbz.length),
      });
      response.end(cbz);
      return;
    }

    // ---------- Kavita-shaped catalog (API key in the path) ----------
    if (url.pathname === "/api/opds/qa-key/catalog") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Kavita Catalog</title>
        <entry><title>QA Kavita Library</title><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/api/opds/qa-key/libraries/one"/></entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/api/opds/qa-key/libraries/one") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Kavita Library</title>
        <entry>
          <title>QA Kavita Chapter</title>
          <link rel="http://opds-spec.org/image" type="image/png" href="/api/opds/qa-key/covers/one.png"/>
          <link rel="http://opds-spec.org/acquisition" type="application/zip" href="/api/opds/qa-key/books/one.cbz"/>
        </entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/api/opds/qa-key/covers/one.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(coverOne);
      return;
    }
    if (url.pathname === "/api/opds/qa-key/books/one.cbz") {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(cbz.length),
      });
      response.end(cbz);
      return;
    }

    // ---------- CBR/RAR chapters ----------
    if (url.pathname === "/cbr/catalog") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA CBR Catalog</title>
        <entry>
          <title>QA CBR Chapter</title>
          <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook-rar" href="/cbr/books/pages.cbr"/>
        </entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/cbr/encrypted-catalog") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Encrypted CBR Catalog</title>
        <entry>
          <title>QA Encrypted Chapter</title>
          <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook-rar" href="/cbr/books/encrypted.cbr"/>
        </entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/cbr/books/pages.cbr") {
      response.writeHead(200, {
        "content-type": "application/vnd.comicbook-rar",
        "content-length": String(cbr.length),
      });
      response.end(cbr);
      return;
    }
    if (url.pathname === "/cbr/books/encrypted.cbr") {
      response.writeHead(200, {
        "content-type": "application/vnd.comicbook-rar",
        "content-length": String(encryptedCbr.length),
      });
      response.end(encryptedCbr);
      return;
    }

    // ---------- Cross-origin traps ----------
    if (url.pathname === "/away/redirect") {
      response.writeHead(302, { location: `${crossOriginOrigin}/leak`, "content-length": "0" });
      response.end();
      return;
    }
    if (url.pathname === "/away/catalog") {
      response.writeHead(200, atom);
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>QA Away Catalog</title>
        <entry>
          <title>Off-origin series</title>
          <link rel="subsection" type="application/atom+xml" href="${crossOriginOrigin}/leak"/>
        </entry>
        <entry>
          <title>Same-origin series</title>
          <link rel="subsection" type="application/atom+xml" href="/away/ok"/>
        </entry>
      </feed>`);
      return;
    }
    if (url.pathname === "/away/ok") {
      response.writeHead(200, atom);
      response.end(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>QA Same Origin</title></feed>`,
      );
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    crossOriginOrigin,
    stats,
    opds: {
      komgaRoot: "/opds/v1.2/catalog",
      kavitaRoot: "/api/opds/qa-key/catalog",
      cbrRoot: "/cbr/catalog",
      encryptedRoot: "/cbr/encrypted-catalog",
      redirectRoot: "/away/redirect",
      awayRoot: "/away/catalog",
      username: "user",
      password: "pass",
      cbrTitle: "QA CBR Chapter",
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => crossOrigin.close(resolve));
    },
  };
}
