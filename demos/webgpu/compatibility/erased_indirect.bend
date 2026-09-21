import Base

def double(n: Nat) -> Nat:
  match n:
    case 0n:
      1n
    case 1n+p:
      +x = double(p)
      Nat.add(x, x)

def pick(-x: Nat, y: U32) -> U32:
  y
def apply(f: @-x: Nat -> U32 -> U32) -> U32:
  f(double(48n), 42)
def main() -> U32:
  apply(pick)
#|42
