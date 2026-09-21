import Base

def show(r: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match r:
    case Done{value}:
      IO.print(value)
    case Fail{error}:
      IO.print("failed")

def read_result(r: File & Result<&1, &1, U32 & String, String>) -> IO(Unit):
  (file, text) = r
  do IO<Unit>:
    File.close(file)
    show(text)

def opened(r: Result<&1, &1, U32 & String, File>) -> IO(Unit):
  match r:
    case Done{file}:
      do IO<Unit>:
        r : File & Result<&1, &1, U32 & String, String> <- File.read(file, 1024)
        read_result(r)
    case Fail{error}:
      IO.print("missing")

def written(r: File & Result<&1, &1, U32 & String, Unit>) -> IO(Unit):
  (file, result) = r
  do IO<Unit>:
    File.close(file)
    opened_file : Result<&1, &1, U32 & String, File> <- File.open("message.txt", "r")
    opened(opened_file)

def writable(r: Result<&1, &1, U32 & String, File>) -> IO(Unit):
  match r:
    case Done{file}:
      do IO<Unit>:
        result : File & Result<&1, &1, U32 & String, Unit> <- File.write(file, "hello 日本語")
        written(result)
    case Fail{error}:
      IO.print("missing")

def main() -> IO(Unit):
  do IO<Unit>:
    file : Result<&1, &1, U32 & String, File> <- File.open("message.txt", "w")
    writable(file)
