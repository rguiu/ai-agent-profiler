// Registry of all handlers, keyed by id.
import { handler00 } from "./handlers/handler00.js";
import { handler01 } from "./handlers/handler01.js";
import { handler02 } from "./handlers/handler02.js";
import { handler03 } from "./handlers/handler03.js";
import { handler04 } from "./handlers/handler04.js";
import { handler05 } from "./handlers/handler05.js";
import { handler06 } from "./handlers/handler06.js";
import { handler07 } from "./handlers/handler07.js";
import { handler08 } from "./handlers/handler08.js";
import { handler09 } from "./handlers/handler09.js";
import { handler10 } from "./handlers/handler10.js";
import { handler11 } from "./handlers/handler11.js";
import { handler12 } from "./handlers/handler12.js";
import { handler13 } from "./handlers/handler13.js";
import { handler14 } from "./handlers/handler14.js";
import { handler15 } from "./handlers/handler15.js";
import { handler16 } from "./handlers/handler16.js";
import { handler17 } from "./handlers/handler17.js";
import { handler18 } from "./handlers/handler18.js";
import { handler19 } from "./handlers/handler19.js";
import { handler20 } from "./handlers/handler20.js";
import { handler21 } from "./handlers/handler21.js";
import { handler22 } from "./handlers/handler22.js";
import { handler23 } from "./handlers/handler23.js";
import { handler24 } from "./handlers/handler24.js";
import { handler25 } from "./handlers/handler25.js";
import { handler26 } from "./handlers/handler26.js";
import { handler27 } from "./handlers/handler27.js";
import { handler28 } from "./handlers/handler28.js";
import { handler29 } from "./handlers/handler29.js";
import { handler30 } from "./handlers/handler30.js";
import { handler31 } from "./handlers/handler31.js";
import { handler32 } from "./handlers/handler32.js";
import { handler33 } from "./handlers/handler33.js";
import { handler34 } from "./handlers/handler34.js";
import { handler35 } from "./handlers/handler35.js";
import { handler36 } from "./handlers/handler36.js";
import { handler37 } from "./handlers/handler37.js";
import { handler38 } from "./handlers/handler38.js";
import { handler39 } from "./handlers/handler39.js";

export const handlers = {
  "00": handler00,
  "01": handler01,
  "02": handler02,
  "03": handler03,
  "04": handler04,
  "05": handler05,
  "06": handler06,
  "07": handler07,
  "08": handler08,
  "09": handler09,
  10: handler10,
  11: handler11,
  12: handler12,
  13: handler13,
  14: handler14,
  15: handler15,
  16: handler16,
  17: handler17,
  18: handler18,
  19: handler19,
  20: handler20,
  21: handler21,
  22: handler22,
  23: handler23,
  24: handler24,
  25: handler25,
  26: handler26,
  27: handler27,
  28: handler28,
  29: handler29,
  30: handler30,
  31: handler31,
  32: handler32,
  33: handler33,
  34: handler34,
  35: handler35,
  36: handler36,
  37: handler37,
  38: handler38,
  39: handler39,
};

export function run(id, input) {
  const fn = handlers[id];
  if (!fn) throw new Error(`no handler ${id}`);
  return fn(input);
}
