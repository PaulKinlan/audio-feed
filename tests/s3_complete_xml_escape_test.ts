/**
 * The CompleteMultipartUpload body escapes the values it interpolates (audio-feed-kply1).
 *
 * THE DEFECT this pins: `completeMultipartXml` built its markup by string interpolation, and
 * the part ETag is a response HEADER taken verbatim from the endpoint
 * (`partRes.headers.get("etag")`). The endpoint is operator-configurable and is already
 * treated as a trust boundary elsewhere in this store, so an ETag is remote-controlled text
 * in a document the app signs. Unescaped, an ETag carrying `</ETag>` closes the element and
 * lets the endpoint inject extra `<Part>` entries into the completion request.
 *
 * The assertion is a round-trip: the document must parse back to exactly the value that went
 * in, with exactly one `<Part>` per part. Escaping is only correct if it is lossless.
 */

import { assertEquals } from "@std/assert";
import { DOMParser } from "npm:linkedom@0.18.12";
import { completeMultipartXml } from "../src/storage/s3.ts";

const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml");

Deno.test("completeMultipartUpload XML round-trips an ETag carrying &, < and a quote", () => {
  // A real S3 ETag is `"<hex>"`; this is what an endpoint that is not S3 may send back.
  const etag = `"e&t<ag>'q"`;
  const doc = parse(completeMultipartXml([{ partNumber: 1, etag }]));
  const parts = doc.querySelectorAll("Part");
  assertEquals(parts.length, 1);
  assertEquals(doc.querySelector("ETag")?.textContent, etag);
});

Deno.test("an ETag that spells a closing tag cannot add parts to the completion body", () => {
  const injected = `"x"</ETag></Part><Part><PartNumber>9</PartNumber><ETag>"y"`;
  const doc = parse(completeMultipartXml([{ partNumber: 1, etag: injected }]));
  assertEquals(doc.querySelectorAll("Part").length, 1);
  assertEquals(doc.querySelector("ETag")?.textContent, injected);
  assertEquals(doc.querySelector("PartNumber")?.textContent, "1");
});
