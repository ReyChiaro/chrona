import os
from pathlib import Path

_checkout = Path(__file__).resolve().parents[3]
ROOT = Path(os.environ['CHRONA_PROJECT_ROOT']) if 'CHRONA_PROJECT_ROOT' in os.environ else (_checkout if (_checkout / 'harness').is_dir() else Path(__file__).resolve().parents[1] / 'resources')
def resource(path: str) -> Path:
    return ROOT / path
