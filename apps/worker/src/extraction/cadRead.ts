// Getting entities out of a CAD file.
//
// DWG goes through libredwg compiled to WebAssembly -- the format is closed
// and there is no other way to read it in process. DXF is parsed here: it is a
// documented text format, and libredwg-web ships with its DXF path commented
// out, so relying on it would be relying on something that is not there.
//
// Both produce the same CadEntity shape, so cadGeometry.ts does not know or
// care which kind of file it came from.

import { createRequire } from "node:module";
import path from "node:path";
import type { CadEntity, CadVertex } from "./cadGeometry";

export type CadFormat = "dwg" | "dxf";

export function cadFormatOf(fileName: string): CadFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".dwg")) return "dwg";
  if (lower.endsWith(".dxf")) return "dxf";
  return null;
}

// ---------------------------------------------------------------------------
// DWG
// ---------------------------------------------------------------------------

// The WASM binary sits beside the package's entry point. Resolved rather than
// hard-coded because pnpm puts the real package under .pnpm/ and the path is
// not guessable from the worker's own directory.
function libredwgWasmDir(): string {
  const require = createRequire(__filename);
  const entry = require.resolve("@mlightcad/libredwg-web");
  return path.join(path.dirname(entry), "..", "wasm") + path.sep;
}

let libredwgPromise: Promise<{ lib: unknown; fileType: number }> | null = null;

async function getLibreDwg() {
  if (!libredwgPromise) {
    libredwgPromise = (async () => {
      // Dynamic import because libredwg-web is ESM-only and the worker
      // compiles to CommonJS; TypeScript preserves import() under NodeNext.
      const mod = (await import("@mlightcad/libredwg-web")) as {
        LibreDwg: { create(wasmPath: string): Promise<unknown> };
        Dwg_File_Type: { DWG: number };
      };
      const lib = await mod.LibreDwg.create(libredwgWasmDir());
      return { lib, fileType: mod.Dwg_File_Type.DWG };
    })();
  }
  return libredwgPromise;
}

async function readDwg(buffer: Buffer): Promise<CadEntity[]> {
  const { lib, fileType } = await getLibreDwg();
  const api = lib as {
    dwg_read_data(data: ArrayBuffer, type: number): unknown;
    convert(data: unknown): { entities?: CadEntity[] };
  };
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const parsed = api.dwg_read_data(bytes, fileType);
  if (!parsed) throw new Error("The DWG could not be decoded. Save it as DXF from CAD and upload that instead.");
  const db = api.convert(parsed);
  return db.entities ?? [];
}

// ---------------------------------------------------------------------------
// DXF
//
// The format is pairs of lines: a group code, then its value. Everything in
// the ENTITIES section between a 0/ENTITY marker and the next one belongs to
// that entity. Only the five types that carry cutting geometry are read;
// anything else is skipped rather than guessed at.
// ---------------------------------------------------------------------------

function readDxf(text: string): CadEntity[] {
  // Tolerant of both CRLF and LF, and of the leading spaces some writers pad
  // group codes with.
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }

  // Find the ENTITIES section. A DXF also carries entities inside BLOCKS, but
  // those are definitions -- they are only real geometry where an INSERT
  // places them, which needs full transform handling. Reading them as if they
  // were placed would put parts at the origin on top of each other.
  let start = -1;
  let end = pairs.length;
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "SECTION" && pairs[i + 1][0] === 2 && pairs[i + 1][1].trim() === "ENTITIES") {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return [];
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "ENDSEC") {
      end = i;
      break;
    }
  }

  const entities: CadEntity[] = [];
  let current: CadEntity | null = null;
  let vertex: CadVertex | null = null;
  // POLYLINE holds its points in following VERTEX entities rather than inline.
  let polyline: CadEntity | null = null;

  const num = (v: string) => Number(v.trim());

  const flushVertex = () => {
    if (vertex && polyline) {
      (polyline.vertices ??= []).push(vertex);
    }
    vertex = null;
  };
  const flushEntity = () => {
    flushVertex();
    if (current && current !== polyline) entities.push(current);
    current = null;
  };

  for (let i = start; i < end; i++) {
    const [code, rawValue] = pairs[i];
    const value = rawValue;

    if (code === 0) {
      const type = value.trim().toUpperCase();
      if (type === "VERTEX") {
        flushVertex();
        vertex = { x: 0, y: 0 };
        continue;
      }
      if (type === "SEQEND") {
        flushVertex();
        if (polyline) entities.push(polyline);
        polyline = null;
        current = null;
        continue;
      }
      flushEntity();
      if (polyline && type !== "VERTEX") {
        // A new entity started without a SEQEND -- take what the polyline has.
        entities.push(polyline);
        polyline = null;
      }
      if (type === "POLYLINE") {
        polyline = { type: "POLYLINE", layer: "0", vertices: [], flag: 0 };
        current = polyline;
      } else if (["LINE", "LWPOLYLINE", "ARC", "CIRCLE"].includes(type)) {
        current = { type, layer: "0" };
      } else {
        current = null;
      }
      continue;
    }

    if (vertex) {
      if (code === 10) vertex.x = num(value);
      else if (code === 20) vertex.y = num(value);
      else if (code === 42) vertex.bulge = num(value);
      continue;
    }
    if (!current) continue;

    switch (code) {
      case 8:
        current.layer = value.trim() || "0";
        break;
      case 10:
        if (current.type === "LINE") current.startPoint = { x: num(value), y: current.startPoint?.y ?? 0 };
        else if (current.type === "ARC" || current.type === "CIRCLE") current.center = { x: num(value), y: current.center?.y ?? 0 };
        else if (current.type === "LWPOLYLINE") (current.vertices ??= []).push({ x: num(value), y: 0 });
        break;
      case 20:
        if (current.type === "LINE") current.startPoint = { x: current.startPoint?.x ?? 0, y: num(value) };
        else if (current.type === "ARC" || current.type === "CIRCLE") current.center = { x: current.center?.x ?? 0, y: num(value) };
        else if (current.type === "LWPOLYLINE" && current.vertices?.length) {
          current.vertices[current.vertices.length - 1].y = num(value);
        }
        break;
      case 11:
        if (current.type === "LINE") current.endPoint = { x: num(value), y: current.endPoint?.y ?? 0 };
        break;
      case 21:
        if (current.type === "LINE") current.endPoint = { x: current.endPoint?.x ?? 0, y: num(value) };
        break;
      case 40:
        if (current.type === "ARC" || current.type === "CIRCLE") current.radius = num(value);
        break;
      case 42:
        // LWPOLYLINE bulge belongs to the vertex it follows.
        if (current.type === "LWPOLYLINE" && current.vertices?.length) {
          current.vertices[current.vertices.length - 1].bulge = num(value);
        }
        break;
      case 50:
        if (current.type === "ARC") current.startAngle = (num(value) * Math.PI) / 180;
        break;
      case 51:
        if (current.type === "ARC") current.endAngle = (num(value) * Math.PI) / 180;
        break;
      case 70:
        current.flag = num(value);
        break;
      default:
        break;
    }
  }
  flushEntity();
  if (polyline) entities.push(polyline);
  return entities;
}

/** Entities from a CAD file, whichever of the two formats it is. */
export async function readCadEntities(buffer: Buffer, format: CadFormat): Promise<CadEntity[]> {
  if (format === "dwg") return readDwg(buffer);
  return readDxf(buffer.toString("utf8"));
}
