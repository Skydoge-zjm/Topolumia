"""Bounded, machine-readable diagnostics for an explicitly selected interpreter."""
import importlib
import importlib.util
import json
import os
import platform
import sys
import shutil

MARKER = "TOPOLUMIA_PYTHON_PROBE:"
# Prefer installed distributions over similarly named files in the project.
sys.path = [entry for entry in sys.path if entry and os.path.normcase(os.path.realpath(entry)) != os.path.normcase(os.path.realpath(os.getcwd()))]


def identity():
    prefix = os.path.realpath(sys.prefix)
    base = os.path.realpath(getattr(sys, "base_prefix", sys.prefix))
    kind = "conda" if os.path.isdir(os.path.join(prefix, "conda-meta")) else "venv" if prefix != base else "system"
    candidate = os.path.join(os.getcwd(), ".venv", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python")
    manager = kind
    if kind == "venv":
        try:
            with open(os.path.join(prefix, "pyvenv.cfg"), encoding="utf-8") as stream:
                if any(line.strip().startswith("uv =") for line in stream.read(16384).splitlines()):
                    manager = "uv"
        except Exception:
            pass
    return {"executable": sys.executable, "realExecutable": os.path.realpath(sys.executable), "manager": manager, "version": platform.python_version(), "prefix": prefix,
            "basePrefix": base, "kind": kind, "projectVenv": candidate if os.path.isfile(candidate) else None}


def package_version(name):
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return None


def packages():
    names = ["jupyterlab", "notebook", "ipykernel", "tensorboard", "wandb", "mlflow", "torch", "jax", "tensorflow"]
    return {"status": "ready", "python": identity(),
            "packages": {name: package_version(name) for name in names},
            "executables": {"nvcc": shutil.which("nvcc")}}


def package_inventory():
    try:
        from importlib import metadata
    except ImportError:
        import importlib_metadata as metadata
    items = {}
    for distribution in metadata.distributions():
        name = distribution.metadata.get("Name")
        version = distribution.version
        if not name or not version:
            continue
        key = name.lower().replace("_", "-").replace(".", "-")
        if key not in items:
            items[key] = {"name": name, "version": version, "source": "python"}
        if len(items) > 10000:
            raise ValueError("Too many distributions for one inventory")
    return {"status": "ready", "python": identity(), "items": sorted(items.values(), key=lambda item: item["name"].lower())}


def jupyter():
    packages = {name: package_version(name) for name in ["jupyterlab", "notebook", "ipykernel", "jupyter_core"]}
    frontend = next((name for name in ["jupyterlab", "notebook"] if packages[name]), None)
    if not frontend:
        return {"status": "not_installed", "packages": packages, "python": identity(), "detail": "当前解释器未安装 JupyterLab 或 Notebook。"}
    importlib.import_module(frontend)
    importlib.import_module("jupyter_core.application")
    return {"status": "ready", "version": packages[frontend], "frontend": frontend, "packages": packages, "python": identity()}


def framework(name):
    result = {"id": name, "status": "not_installed", "version": None, "gpuAvailable": None,
              "cudaVersion": None, "cudnnVersion": None, "ncclVersion": None, "devices": [], "gpuTest": "not_run"}
    if importlib.util.find_spec(name) is None:
        return result
    try:
        module = importlib.import_module(name)
        result.update(status="ready", version=str(module.__version__))
        if name == "torch":
            result["cudaVersion"] = module.version.cuda
            cudnn = module.backends.cudnn.version()
            if cudnn:
                factor = 10000 if cudnn >= 90000 else 1000
                result["cudnnVersion"] = "%s.%s.%s" % (cudnn // factor, (cudnn % factor) // 100, cudnn % 100)
            result["gpuAvailable"] = bool(module.cuda.is_available())
            if result["gpuAvailable"]:
                for index in range(min(module.cuda.device_count(), 8)):
                    device = module.cuda.get_device_properties(index)
                    result["devices"].append({"name": device.name, "memoryMiB": int(device.total_memory / 1048576)})
                try:
                    result["ncclVersion"] = ".".join(map(str, module.cuda.nccl.version()))
                except Exception:
                    pass
                module.ones(1, device="cuda").sum().item()
                module.cuda.synchronize()
                result["gpuTest"] = "passed"
            else:
                module.ones(1).sum().item()
                result["gpuTest"] = "unavailable"
        elif name == "jax":
            devices = module.devices()
            gpus = [device for device in devices if device.platform in ("gpu", "cuda")]
            result["gpuAvailable"] = bool(gpus)
            result["devices"] = [{"name": str(getattr(device, "device_kind", device))[:160]} for device in gpus[:8]]
            numpy = importlib.import_module("jax.numpy")
            if gpus:
                with module.default_device(gpus[0]):
                    numpy.ones((1,)).sum().block_until_ready()
                result["gpuTest"] = "passed"
            else:
                numpy.ones((1,)).sum().block_until_ready()
                result["gpuTest"] = "unavailable"
        elif name == "tensorflow":
            devices = module.config.list_physical_devices("GPU")
            for device in devices:
                module.config.experimental.set_memory_growth(device, True)
            build = module.sysconfig.get_build_info()
            result["cudaVersion"] = str(build.get("cuda_version")) if build.get("cuda_version") else None
            result["cudnnVersion"] = str(build.get("cudnn_version")) if build.get("cudnn_version") else None
            result["gpuAvailable"] = bool(devices)
            result["devices"] = [{"name": device.name[:160]} for device in devices[:8]]
            with module.device("/GPU:0" if devices else "/CPU:0"):
                output = module.reduce_sum(module.ones((1,)))
                output.numpy()
            result["gpuTest"] = "passed" if devices and "GPU" in output.device.upper() else "unavailable"
    except Exception as error:
        result.update(status="error", detail=str(error)[:600])
        if result["gpuAvailable"]:
            result["gpuTest"] = "failed"
    return result


try:
    mode = sys.argv[1] if len(sys.argv) > 1 else "identity"
    if mode == "identity":
        payload = {"status": "ready", "python": identity()}
    elif mode == "jupyter":
        payload = jupyter()
    elif mode == "packages":
        payload = packages()
    elif mode == "package_inventory":
        payload = package_inventory()
    elif mode in ("torch", "jax", "tensorflow"):
        payload = framework(mode)
    else:
        raise ValueError("Unknown diagnostic mode")
except Exception as error:
    payload = {"status": "error", "detail": str(error)[:600]}
print(MARKER + json.dumps(payload, ensure_ascii=True, allow_nan=False), flush=True)
