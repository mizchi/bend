import Base
# correctness: FWHT is an involution up to scale.
#   FWHT(FWHT(x)) == 2^d * x     for every x
# so  total(FWHT(FWHT(x))) == 2^d * total(x)  (mod 2^32)

type T is Data:
  L{v: U32}
  N{a: T, b: T}

type P is Data:
  Pr{p: T, m: T}

def bfly.join(ra: P, rb: P) -> P:
  match ra rb:
    case Pr{pa, ma} Pr{pb, mb}:
      Pr{N{pa, pb}, N{ma, mb}}

def fwht.comb(r: P) -> T:
  match r:
    case Pr{p, m}:
      N{p, m}

def bfly(x: T, y: T) -> P:
  match x y:
    case L{+u} L{+v}:
      Pr{L{U32.add(u, v)}, L{U32.sub(u, v)}}
    case N{xa, xb} N{ya, yb}:
      ra rb = bfly(xa, ya) bfly(xb, yb)
      bfly.join(ra, rb)
    case L{u} N{ya, yb}:
      Pr{L{0}, L{0}}
    case N{xa, xb} L{v}:
      Pr{L{0}, L{0}}

def fwht(t: T) -> T:
  match t:
    case L{v}:
      L{v}
    case N{a, b}:
      a2 b2 = fwht(a) fwht(b)
      fwht.comb(bfly(a2, b2))

# xs[i] = a cheap hash of i, so the input is not degenerate
def hash(+i: U32) -> U32:
  U32.xor(U32.mul(U32.inc(i), 2654435761), U32.shrn(i, 3n))

def mk(+d: Nat, +i: U32) -> T:
  match d:
    case 0n:
      L{hash(i)}
    case 1n+p:
      a b = mk(p, i) mk(p, U32.add(i, U32.shln(1, p)))
      N{a, b}

def total(t: T) -> U32:
  match t:
    case L{v}:
      v
    case N{a, b}:
      x y = total(a) total(b)
      (x + y : U32)

# LHS: total(FWHT(FWHT(x)))
def lhs(+d: Nat) -> U32:
  total(fwht(fwht(mk(d, 0))))

# RHS: 2^d * total(x)
def rhs(+d: Nat) -> U32:
  U32.mul(U32.shln(1, d), total(mk(d, 0)))

def show(+d: Nat) -> String:
  Bool.show(U32.is_eq(lhs(d), rhs(d)))

def main() -> IO(Unit):
  do IO<Unit>:
    IO.print("d=1  involution: " ++ show(1n))
    IO.print("d=2  involution: " ++ show(2n))
    IO.print("d=5  involution: " ++ show(5n))
    IO.print("d=10 involution: " ++ show(10n))
