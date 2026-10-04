import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError } from "./error-detail";

describe("describeError", () => {
  it("incluye la causa de red y oculta URLs y credenciales", () => {
    const error = new TypeError("fetch failed https://api.oddspapi.io/v4/odds?apiKey=SECRET123&x=1", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    const text = describeError(error, ["SECRET123"]);
    assert.ok(text.includes("TypeError") && text.includes("ENOTFOUND"));
    assert.ok(!text.includes("SECRET123") && !text.includes("api.oddspapi.io"));
  });
  it("devuelve vacío si no es un Error", () => {
    assert.equal(describeError("texto"), "");
  });
});
