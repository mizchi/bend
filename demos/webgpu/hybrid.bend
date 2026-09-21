import Base
type Tree is Data:
  Leaf{v: U32}
  Branch{a: Tree, b: Tree}
def make(+n: Nat, +v: U32) -> Tree:
  match n:
    case 0n:
      Leaf{v}
    case 1n+p:
      Branch{make(p, v), make(p, U32.inc(v))}
def sum(t: Tree) -> U32:
  match t:
    case Leaf{v}:
      v
    case Branch{a, b}:
      x y = sum(a) sum(b)
      U32.add(x, y)
def double(+t: Tree) -> U32:
  x y = sum(t) sum(t)
  U32.add(x, y)
def run(+t: Tree) -> IO(Unit):
  do IO<Unit>:
    IO.print("GPU tree ready")
    IO.print(U32.show(double!(t)))
    IO.print(U32.show(sum(t)))
def main() -> IO(Unit):
  do IO<Unit>:
    IO.print("開始")
    run(make!(5n, 3))
