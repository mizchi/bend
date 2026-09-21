import Base

def double(n: Nat) -> Nat:
  match n:
    case 0n:
      1n
    case 1n+p:
      +x = double(p)
      Nat.add(x, x)

def main() -> U32:
  -x = double(48n)
  42
#|42
