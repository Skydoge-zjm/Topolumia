"""Read-only SSH environment discovery. Input is a fixed mode and JSON options."""
import getpass
import glob
import json
import os
import platform
import shutil
import subprocess
import sys

MARKER = "TOPOLUMIA_REMOTE_PROBE:"


def canonical(value):
    return os.path.realpath(os.path.expanduser(value))


def tool(name, configured=None):
    if configured:
        expanded = os.path.expanduser(configured)
        if os.path.isfile(expanded):
            return canonical(expanded)
        found = shutil.which(expanded)
        if found:
            return found
        return None
    found = shutil.which(name)
    if found:
        return found
    home = os.path.expanduser("~")
    candidates = {
        "conda": [os.path.join(home, prefix, "bin", "conda") for prefix in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"]] + ["/opt/conda/bin/conda"],
        "nvidia-smi": ["/usr/lib/wsl/lib/nvidia-smi", "/usr/local/bin/nvidia-smi"],
        "nvcc": ["/usr/local/cuda/bin/nvcc"],
    }
    return next((canonical(candidate) for candidate in candidates.get(name, []) if os.path.isfile(candidate)), None)


def identity(executable):
    code = "import json,os,platform,sys; p=os.path.realpath(sys.prefix); b=os.path.realpath(getattr(sys,'base_prefix',sys.prefix)); print(json.dumps({'executable':sys.executable,'prefix':p,'version':platform.python_version(),'kind':'conda' if os.path.isdir(os.path.join(p,'conda-meta')) else 'venv' if p!=b else 'system'}))"
    result = subprocess.run([executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=6, text=True)
    if result.returncode:
        return None
    return json.loads(result.stdout.strip().splitlines()[-1])


def discover(source, options):
    entries = {}
    if source == "conda":
        command = tool("conda", options.get("condaCommand"))
        if not command:
            raise ValueError("Conda manager was not found")
        result = subprocess.run([command, "info", "--json"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, text=True)
        if result.returncode or len(result.stdout) > 2097152:
            raise ValueError("Conda discovery failed")
        info = json.loads(result.stdout)
        base = canonical(info["root_prefix"])
        for prefix in [base] + list(info.get("envs", []))[:200]:
            if not isinstance(prefix, str):
                continue
            prefix = canonical(prefix)
            executable = os.path.join(prefix, "bin", "python")
            entries[prefix] = {"source": "conda", "prefix": prefix, "pythonCommand": executable,
                               "name": "base" if prefix == base else os.path.basename(prefix), "manager": "conda", "hasPython": os.path.isfile(executable)}
    elif source == "venv":
        directory = options.get("directory")
        if not directory:
            return {"entries": [], "needsDirectory": True}
        directory = canonical(directory)
        for name in [".venv", "venv", "env"]:
            prefix = canonical(os.path.join(directory, name))
            cfg = os.path.join(prefix, "pyvenv.cfg")
            if not os.path.isfile(cfg):
                continue
            with open(cfg, encoding="utf-8", errors="replace") as stream:
                content = stream.read(16384)
            executable = os.path.join(prefix, "bin", "python")
            entries[prefix] = {"source": "venv", "prefix": prefix, "pythonCommand": executable, "name": name,
                               "manager": "uv" if any(line.strip().startswith("uv =") for line in content.splitlines()) else "venv", "hasPython": os.path.isfile(executable)}
    elif source == "python":
        candidates = [sys.executable, tool("python"), tool("python3")] + sorted(glob.glob("/usr/bin/python3.[0-9]*"))[:8]
        seen = set()
        for executable in candidates:
            if not executable or not os.path.isfile(executable) or canonical(executable) in seen:
                continue
            seen.add(canonical(executable))
            try:
                info = identity(executable)
            except Exception:
                continue
            if not info or info["kind"] != "system":
                continue
            entries[canonical(info["executable"])] = {"source": "python", "prefix": info["prefix"], "pythonCommand": info["executable"],
                                                      "identityPath": canonical(info["executable"]), "name": "Python " + info["version"], "manager": "python", "hasPython": True}
    else:
        raise ValueError("Unknown environment source")
    return {"entries": list(entries.values())}


try:
    mode = sys.argv[1]
    options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    if mode == "info":
        value = {"platform": platform.system(), "user": getpass.getuser(), "home": os.path.expanduser("~"), "python": sys.executable,
                 "tools": {key: tool(command, options.get(key + "Command")) for key, command in {"conda": "conda", "nvidia": "nvidia-smi", "cuda": "nvcc", "uv": "uv", "git": "git", "docker": "docker"}.items()}}
    elif mode == "directory":
        directory = canonical(options["directory"])
        if not os.path.isdir(directory) or not os.access(directory, os.R_OK | os.X_OK):
            raise ValueError("Remote directory is not accessible")
        value = {"directory": directory}
    elif mode == "discover":
        value = discover(options["source"], options)
    else:
        raise ValueError("Unknown remote diagnostic mode")
    print(MARKER + json.dumps({"status": "ready", **value}, ensure_ascii=True))
except Exception:
    print(MARKER + json.dumps({"status": "error", "detail": "Remote environment discovery could not complete."}))
