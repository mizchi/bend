// Bend 75cb8f3e: Term = u64, loc[0:40], aux[40:56], tag[56:63], RFC[63].
// This representation preserves the two little-endian u32 words of the C ABI.
alias Word = vec2<u32>;

fn word_add(a: Word, b: Word) -> Word {
  let low = a.x + b.x;
  return Word(low, a.y + b.y + select(0u, 1u, low < a.x));
}

fn term_tag(t: Word) -> u32 { return (t.y >> 24u) & 0x7fu; }
fn term_aux(t: Word) -> u32 { return (t.y >> 8u) & 0xffffu; }
fn term_loc(t: Word) -> Word { return Word(t.x, t.y & 0xffu); }
fn term_rfc(t: Word) -> u32 { return t.y >> 31u; }

fn term_pack(tag: u32, aux: u32, loc: Word, rfc: u32) -> Word {
  return Word(loc.x, (loc.y & 0xffu) | ((aux & 0xffffu) << 8u)
    | ((tag & 0x7fu) << 24u) | ((rfc & 1u) << 31u));
}
