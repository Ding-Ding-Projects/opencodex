/**
 * `src/lib/converter/xml-convert.ts` — JSON <-> XML.
 *
 * The billion-laughs family of tests comes first: this module's whole safety
 * argument rests on never implementing entity expansion at all, on two
 * independent paths (refusing any markup declaration, and refusing any
 * non-predefined entity reference), so both paths get their own adversarial
 * proof rather than one combined smoke test.
 */
import { describe, expect, test } from "bun:test";
import { MAX_STRUCTURED_DEPTH, MAX_STRUCTURED_INPUT_BYTES, MAX_XML_NODES } from "../src/lib/converter/bounds";
import { jsonToXml, xmlToJson } from "../src/lib/converter/xml-convert";

describe("xmlToJson: billion-laughs and entity-expansion defenses", () => {
  test("refuses a real billion-laughs DOCTYPE outright, before any entity is ever expanded", () => {
    const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;
    const result = xmlToJson(billionLaughs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("unsupported");
  });

  test("refuses a bare DOCTYPE with no entities too — the whole declaration class is refused, not just ENTITY", () => {
    const result = xmlToJson('<?xml version="1.0"?><!DOCTYPE root SYSTEM "http://example.com/root.dtd"><root>hi</root>');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("unsupported");
  });

  test("refuses a custom entity reference even with no DOCTYPE present — the second, independent defense", () => {
    // A parser reached this text some other way (e.g. this document is itself
    // the tail of a larger stream); the reference must still be refused on
    // its own, because custom entities are simply never recognised.
    const result = xmlToJson("<root>&customEntity;</root>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses an unbounded '&' with no terminating ';' nearby, rather than scanning the whole document for one", () => {
    const result = xmlToJson(`<root>${"&".padEnd(200, "x")}</root>`);
    expect(result.ok).toBe(false);
  });

  test("the five predefined entities still decode correctly — refusal is about custom entities, not all entities", () => {
    const result = xmlToJson("<root>&lt;tag&gt; &amp; &apos;quote&apos; &quot;double&quot;</root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: "<tag> & 'quote' \"double\"" });
  });

  test("numeric character references (decimal and hex) decode to the real character, with no recursive substitution possible", () => {
    const result = xmlToJson("<root>&#65;&#x42;</root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: "AB" });
  });

  test("refuses an invalid numeric character reference", () => {
    const result = xmlToJson("<root>&#zzz;</root>");
    expect(result.ok).toBe(false);
  });
});

describe("xmlToJson: depth- and node-count bombs with no entities at all", () => {
  test("refuses a document nested deeper than MAX_STRUCTURED_DEPTH, as a clean boundary rather than a stack overflow", () => {
    const depth = MAX_STRUCTURED_DEPTH + 50;
    const xml = "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
    const result = xmlToJson(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("bomb-suspected");
  });

  test("refuses a flat document with more than MAX_XML_NODES elements", () => {
    const count = MAX_XML_NODES + 10;
    const xml = `<root>${"<a/>".repeat(count)}</root>`;
    const result = xmlToJson(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("bomb-suspected");
  });

  test("a document at exactly the depth bound still parses successfully — the bound is not off by a costly margin", () => {
    const depth = MAX_STRUCTURED_DEPTH;
    const xml = "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
    const result = xmlToJson(xml);
    expect(result.ok).toBe(true);
  });
});

describe("xmlToJson: other malformed input", () => {
  test("refuses input over the size limit before parsing", () => {
    const huge = "<a>" + "x".repeat(MAX_STRUCTURED_INPUT_BYTES) + "</a>";
    const result = xmlToJson(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("too-large");
  });

  test("refuses an unclosed element", () => {
    const result = xmlToJson("<root><child>text</root>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses a document with more than one root element", () => {
    const result = xmlToJson("<a/><b/>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses a document with no elements at all", () => {
    const result = xmlToJson("just some text, no tags");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses an unclosed comment", () => {
    const result = xmlToJson("<root><!-- never closed</root>");
    expect(result.ok).toBe(false);
  });

  test("refuses an unclosed CDATA section", () => {
    const result = xmlToJson("<root><![CDATA[ never closed</root>");
    expect(result.ok).toBe(false);
  });
});

describe("xmlToJson: the real, well-formed cases", () => {
  test("a leaf element with only text becomes a plain string", () => {
    const result = xmlToJson("<name>Ada Lovelace</name>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "Ada Lovelace" });
  });

  test("attributes land under @attributes", () => {
    const result = xmlToJson('<person id="1" active="true">Ada</person>');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ person: { "@attributes": { id: "1", active: "true" }, "@text": "Ada" } });
    }
  });

  test("repeated same-named children become an array; a single occurrence stays a bare value", () => {
    const result = xmlToJson("<people><person>Ada</person><person>Alan</person><city>London</city></people>");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ people: { person: ["Ada", "Alan"], city: "London" } });
    }
  });

  test("a self-closing element with no attributes becomes an empty string", () => {
    const result = xmlToJson("<root><empty/></root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: { empty: "" } });
  });

  test("comments and processing instructions are ignored, not treated as content", () => {
    const result = xmlToJson('<?xml version="1.0"?><root><!-- a comment -->hello</root>');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: "hello" });
  });

  test("CDATA content is taken literally, with no entity decoding inside it", () => {
    const result = xmlToJson("<root><![CDATA[<not a tag> & &fake;]]></root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: "<not a tag> & &fake;" });
  });

  test("insignificant whitespace between elements is discarded", () => {
    const result = xmlToJson("<root>\n  <a>1</a>\n  <b>2</b>\n</root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ root: { a: "1", b: "2" } });
  });
});

describe("jsonToXml: the failure paths", () => {
  test("refuses a key that cannot become an XML element name", () => {
    const result = jsonToXml({ "not a valid tag name!": 1 });
    expect(result.ok).toBe(false);
  });

  test("refuses a value nested deeper than MAX_STRUCTURED_DEPTH", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < MAX_STRUCTURED_DEPTH + 10; i++) value = { child: value };
    const result = jsonToXml(value);
    expect(result.ok).toBe(false);
  });
});

describe("jsonToXml: discloses the type/shape loss it always causes", () => {
  test("every successful result is marked lossy with real notes", () => {
    const result = jsonToXml({ n: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lossy).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("jsonToXml / xmlToJson: real round trips", () => {
  test("a flat object of scalars round-trips its values as text", () => {
    const source = { name: "Ada", age: 36, active: true };
    const xml = jsonToXml(source, "person");
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    const back = xmlToJson(xml.text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual({ person: { name: "Ada", age: "36", active: "true" } });
  });

  test("an array property becomes repeated sibling elements, and reads back as an array", () => {
    const xml = jsonToXml({ tags: ["a", "b", "c"] }, "doc");
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    const back = xmlToJson(xml.text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual({ doc: { tags: ["a", "b", "c"] } });
  });

  test("special characters in text content are escaped and round-trip exactly", () => {
    const xml = jsonToXml({ note: "a < b & c > d" }, "doc");
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    const back = xmlToJson(xml.text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual({ doc: { note: "a < b & c > d" } });
  });

  test("a top-level array wraps into a rootTag of same-named <item> children", () => {
    const xml = jsonToXml([1, 2, 3], "numbers");
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    const back = xmlToJson(xml.text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual({ numbers: { item: ["1", "2", "3"] } });
  });

  test("null/undefined become an empty element and read back as an empty string", () => {
    const xml = jsonToXml({ maybe: null }, "doc");
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    const back = xmlToJson(xml.text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual({ doc: { maybe: "" } });
  });
});
