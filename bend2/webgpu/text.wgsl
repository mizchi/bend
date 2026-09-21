// Literal and decimal producers share the ordinary Bend String layout.
// New roots have no external reference until the caller installs a register.
fn text_nil() -> vec2u {
  let slot = allocate_node(__SNIL__u, 0u);
  if (slot == 0xffffffffu) { return vec2u(0u); }
  return vec2u(slot, 0x80000000u);
}
fn text_cons(code: u32, tail: vec2u) -> vec2u {
  let chr = allocate_node(__CHR__u, 1u);
  if (chr == 0xffffffffu) { return vec2u(0u); }
  heap[chr].fields[0] = vec2u(code, 0u);
  let cons = allocate_node(__SCON__u, 2u);
  if (cons == 0xffffffffu) { return vec2u(0u); }
  let head = vec2u(chr, 0x80000000u);
  heap[cons].fields[0] = head;
  heap[cons].fields[1] = tail;
  retain(head); retain(tail);
  return vec2u(cons, 0x80000000u);
}
fn text_decimal(input: vec2u) -> vec2u {
  var value = input;
  var tail = text_nil();
  loop {
    // Divide a 48-bit Nat by ten using three base-65536 digits. Each
    // intermediate fits u32; no floating point rounding is involved.
    let mid = (value.y % 10u) * 65536u + (value.x >> 16u);
    let low = (mid % 10u) * 65536u + (value.x & 65535u);
    tail = text_cons(48u + low % 10u, tail);
    if (atomicLoad(&control.error) != 0u) { return vec2u(0u); }
    value = vec2u(((mid / 10u) << 16u) | (low / 10u), value.y / 10u);
    if (all(value == vec2u(0u))) { break; }
  }
  return tail;
}
fn text_literal(id: u32) -> vec2u {
  var tail = text_nil();
  if (atomicLoad(&control.error) != 0u) { return vec2u(0u); }
  switch (id) {
    __TEXT_CASES__
    default: { fail(8u); }
  }
  return tail;
}
