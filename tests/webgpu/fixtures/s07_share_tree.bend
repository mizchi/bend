import Base
type T is Data:
  L{v: U32}
  N{a: T, b: T}

def sum(t: T) -> U32:
  match t:
    case L{v}:
      v
    case N{a, b}:
      x y = sum(a) sum(b)
      U32.add(x, y)

def twice(+t: T) -> U32:
  x y = sum(t) sum(t)
  U32.add(x, y)

def main() -> IO(Unit):
  IO.print(U32.show(twice(N{L{3}, L{4}})))
