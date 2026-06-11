import { describe, it, expect } from "vitest";
import { isHttpUrl, htmlToText, isPrivateAddress } from "@/lib/web-fetch";

describe("isPrivateAddress (SSRF host guard)", () => {
  it("flags loopback / private / link-local / metadata / CGNAT IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud instance metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.15.0.1",
      "172.32.0.1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it("flags loopback / unspecified / ULA / link-local IPv6 (and v4-mapped)", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // dotted v4-mapped
      // HEX v4-mapped — the form new URL()/dns.lookup actually emit:
      "::ffff:a9fe:a9fe", // 169.254.169.254 (cloud metadata)
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:c0a8:101", // 192.168.1.1
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("allows public IPv6, and treats an empty address as unsafe", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com/issues/1")).toBe(true);
    expect(isHttpUrl("https://example.com:8443/x?y=1#z")).toBe(true);
  });

  it("is case-insensitive on the scheme", () => {
    expect(isHttpUrl("HTTPS://example.com")).toBe(true);
    expect(isHttpUrl("Http://example.com")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com/x")).toBe(false);
    expect(isHttpUrl("ws://example.com")).toBe(false);
  });

  it("rejects non-URLs and relative/blank input", () => {
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
    expect(isHttpUrl("/relative/path")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("strips tags and keeps readable text", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("drops script/style/noscript contents", () => {
    const html =
      "<style>.a{color:red}</style><p>Keep</p>" +
      "<script>var x = 1 < 2;</script><noscript>nope</noscript>";
    expect(htmlToText(html)).toBe("Keep");
  });

  it("strips HTML comments", () => {
    expect(htmlToText("<!-- secret --><p>Visible</p>")).toBe("Visible");
  });

  it("turns block boundaries and <br> into newlines", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(htmlToText("a<br>b<br/>c")).toBe("a\nb\nc");
    expect(htmlToText("<li>x</li><li>y</li>")).toBe("x\ny");
  });

  it("decodes common named and numeric entities", () => {
    expect(htmlToText("<p>a &amp; b &lt; c &gt; d</p>")).toBe("a & b < c > d");
    expect(htmlToText("<p>x&nbsp;y</p>")).toBe("x y");
    expect(htmlToText("<p>&#65;&#x42;&#39;</p>")).toBe("AB'");
  });

  it("leaves an unknown entity untouched", () => {
    expect(htmlToText("<p>&unknownentity; stays</p>")).toBe(
      "&unknownentity; stays"
    );
  });

  it("collapses inner whitespace and trims the ends", () => {
    const html = "  <p>  first   line  </p>  <div></div>  ";
    expect(htmlToText(html)).toBe("first line");
  });

  it("collapses 3+ blank lines down to a single blank line", () => {
    const html = "<p>first</p>\n\n\n\n<p>second</p>";
    expect(htmlToText(html)).toBe("first\n\nsecond");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});
