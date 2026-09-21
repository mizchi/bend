import Base
def tree(+d: Nat, +i: U32) -> U32:
  match d:
    case 0n:
      i
    case 1n+p:
      a b = tree(p, i) tree(p, U32.add(i, U32.shln(1, p)))
      U32.add(a, b)

def main() -> IO(Unit):
  IO.print(U32.show(tree!(20n, 0)))
