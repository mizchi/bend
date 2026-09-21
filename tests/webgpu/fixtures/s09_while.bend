import Base
def go(+i: U32, +n: U32, more: Bool) -> U32:
  match more:
    case False{}:
      i
    case True{}:
      go(U32.inc(i), n, U32.is_lt(U32.inc(i), n))

def main() -> IO(Unit):
  IO.print(U32.show(go(0, 10, True{})))
