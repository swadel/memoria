import subprocess
import sys
from pathlib import Path


def main() -> int:
    sidecar_dir = Path(__file__).resolve().parent
    script_path = sidecar_dir / "icloud_bridge.py"
    dist_dir = sidecar_dir
    work_dir = sidecar_dir / "build"

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--name",
        "icloud_bridge",
        "--distpath",
        str(dist_dir),
        "--workpath",
        str(work_dir),
        str(script_path),
    ]
    print("Running:", " ".join(cmd))
    return subprocess.call(cmd, cwd=str(sidecar_dir))


if __name__ == "__main__":
    raise SystemExit(main())
