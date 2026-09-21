import Base
def first(r: Array<U32> & U32) -> U32:
  (a, v) = r
  v

def main() -> IO(Unit):
  IO.print(U32.show(first(Array.new(U32, 2n, 7)[0])))
