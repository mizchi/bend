import Base

def double(n: Nat, +x: Nat) -> Nat:
  match n:
    case 0n: x
    case 1n+p: double(p, Nat.add(x, x))
def head(s: String) -> U32:
  match s:
    case SNil{}: 0
    case SCon{Chr{x}, tail}: x

def main() -> IO(Unit):
  do IO<Unit>:
    IO.print(Nat.show(String.length("a日😀")))
    IO.print(String.reverse!(String.append("a日", "😀")))
    IO.print(Nat.show(String.length(U32.show!(4294967295))))
    IO.print(Nat.show(String.length(Nat.show!(Nat.add(double(16n, 4294967295n), 65535n)))))
    IO.print(String.reverse(Nat.show(Nat.add(4294967295n, 2n))))
    IO.print(U32.show(head(Bool.show(True{}))))
    IO.print(String.take(String.append("", U32.show(0)), 1n))
    IO.print(Bool.show(String.eq(String.drop("abc", 1n), "bc")))
#|3
#|😀日a
#|10
#|15
#|7927694924
#|84
#|0
#|True
