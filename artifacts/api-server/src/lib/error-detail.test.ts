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
  it("en errores de consulta muestra la causa de Postgres y no el SQL", () => {
    const pg = Object.assign(new Error('null value in column "selection" violates not-null constraint'), { code: "23502", column: "selection" });
    const error = new Error('Failed query: insert into "odds_quotes" ("id", "match_id") values ($1, $2) params: 1,2', { cause: pg });
    const text = describeError(error);
    assert.ok(text.includes("23502") && text.includes("not-null") && text.includes("columna selection"), text);
    assert.ok(!text.includes("insert into"), text);
  });
});
