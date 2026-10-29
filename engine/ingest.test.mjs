import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function withIngestFixture(run) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ideaforge-ingest-test-")));
  try {
    await mkdir(path.join(root, "engine"));
    await Promise.all(["ingest.mjs", "forge.mjs", "generate.mjs", "engines.mjs"].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), path.join(root, "engine", name))));
    const modulePath = path.join(root, "engine", "ingest.mjs");
    const { ingest } = await import(pathToFileURL(modulePath).href);
    const { classifyInput } = await import(pathToFileURL(path.join(root, "engine", "forge.mjs")).href);
    await run({ root, ingest, classifyInput });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function atFixedTime(run) {
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : ["2026-10-29T00:00:00.000Z"]));
    }
  };
  try {
    await run();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

test("same-millisecond text ingests retain every distinct source record", async () => {
  await withIngestFixture(async ({ ingest }) => {
    await atFixedTime(async () => {
      const sources = Array.from({ length: 12 }, (_, i) => `Same title\nSynthetic source ${i}`);
      const records = await Promise.all(sources.map((source) => ingest(source, "text")));
      assert.equal(new Set(records.map((record) => record.archivePath)).size, sources.length);
      for (const [i, record] of records.entries()) {
        const archived = JSON.parse(await readFile(record.archivePath, "utf8"));
        assert.equal(archived.rawContent, sources[i]);
        assert.equal(archived.fetchedAt, "2026-10-29T00:00:00.000Z");
      }
    });
  });
});

test("same-millisecond image ingests retain same-named originals separately", async () => {
  await withIngestFixture(async ({ root, ingest }) => {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const curl = path.join(bin, "curl");
    await writeFile(curl, '#!/bin/sh\nprintf \'%s\' \'{"response":"Synthetic OCR only"}\'\n');
    await chmod(curl, 0o700);
    const originals = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const dir = path.join(root, `source-${i}`);
      await mkdir(dir);
      const file = path.join(dir, "same.svg");
      await writeFile(file, `<svg xmlns="http://www.w3.org/2000/svg"><text>Synthetic ${i}</text></svg>`);
      return file;
    }));
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath || ""}`;
    try {
      await atFixedTime(async () => {
        const records = await Promise.all(originals.map((file) => ingest(file, "image")));
        assert.equal(new Set(records.map((record) => record.archivedImage)).size, originals.length);
        assert.equal(new Set(records.map((record) => record.archivePath)).size, originals.length);
        for (const [i, record] of records.entries()) {
          assert.equal(record.rawContent, "Synthetic OCR only");
          assert.equal(await readFile(record.archivedImage, "utf8"), await readFile(originals[i], "utf8"));
          const archived = JSON.parse(await readFile(record.archivePath, "utf8"));
          assert.equal(archived.imagePath, originals[i]);
          assert.equal(archived.archivedImage, record.archivedImage);
        }
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("image classification and ingest resolve project-relative paths consistently", async () => {
  await withIngestFixture(async ({ root, ingest, classifyInput }) => {
    const inputs = path.join(root, "inputs");
    const caller = path.join(root, "caller");
    await mkdir(inputs);
    await mkdir(caller);
    const imagePath = path.join(inputs, "example.svg");
    await writeFile(imagePath, '<svg xmlns="http://www.w3.org/2000/svg"><text>Project fixture</text></svg>');
    // An executable mock prevents any request to a real Ollama service.
    const curl = path.join(caller, "curl");
    await writeFile(curl, '#!/bin/sh\nprintf \'%s\' \'{"response":"Project fixture OCR"}\'\n');
    await chmod(curl, 0o700);
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.PATH = `${caller}${path.delimiter}${previousPath || ""}`;
    process.chdir(caller);
    try {
      const input = "./inputs/example.svg";
      const type = await classifyInput(input);
      assert.equal(type, "image");
      const record = await ingest(input, type);
      assert.equal(record.imagePath, imagePath);
      assert.equal(record.rawContent, "Project fixture OCR");
      assert.equal(await readFile(record.archivedImage, "utf8"), await readFile(imagePath, "utf8"));

      const callerImage = path.join(caller, "local.svg");
      await writeFile(callerImage, '<svg xmlns="http://www.w3.org/2000/svg"><text>Caller fixture</text></svg>');
      for (const candidate of ["./local.svg", callerImage]) {
        assert.equal(await classifyInput(candidate), "image");
        const localRecord = await ingest(candidate, "image");
        assert.equal(localRecord.imagePath, callerImage);
        assert.equal(await readFile(localRecord.archivedImage, "utf8"), await readFile(callerImage, "utf8"));
      }

      await mkdir(path.join(caller, "inputs"));
      await writeFile(path.join(caller, "inputs", "example.svg"), "Different caller file");
      assert.equal((await ingest(input, "image")).imagePath, imagePath, "Keep project-relative precedence");
      await mkdir(path.join(caller, "directory.png"));
      assert.equal(await classifyInput("./directory.png"), "text");
      assert.equal(await classifyInput(`${"Synthetic text ".repeat(30)}.png`), "text");
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
