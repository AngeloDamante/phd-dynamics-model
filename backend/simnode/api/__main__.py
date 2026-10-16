"""``python -m simnode.api [--host H] [--port P] [--diagrams DIR]``"""

import argparse

import uvicorn

from .app import create_app


def main() -> None:
    """Run the development server."""
    parser = argparse.ArgumentParser(description="simnode web server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--diagrams", default="diagrams", help="directory for saved diagrams")
    args = parser.parse_args()
    uvicorn.run(create_app(args.diagrams), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
