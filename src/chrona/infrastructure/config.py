from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr
from .resources import resource


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CHRONA_", env_file=".env", extra="ignore"
    )
    data_dir: Path = Path(".data/render")
    provider: str = "chrona.adapters.providers.minimax:ReferenceRenderer"
    model_path: Path | None = None
    model_revision: str = ""
    lora_dir: Path = Path(".data/loras")
    device: str = "cuda:0"
    memory_reserve: str = "18GB"
    attention_backend: str = "native"
    upload_limit_mb: int = 1024
    observation_limit: int = 500000
    metadata_limit_mb: int = 64
    queue_limit: int = 8
    preload: bool = False
    profile_path: Path = resource("configs/render-profile.json")
    video_provider: str = (
        "chrona.adapters.providers.local_reference:LocalReferenceRenderer"
    )
    video_service_url: str = "http://127.0.0.1:8088"
    video_service_token: SecretStr = SecretStr("")
    video_profile: str = ""
    route_poll_seconds: float = 5
    route_timeout_seconds: int = 14400
    agent_enabled: bool = True
    agent_base_url: str = ""
    agent_model: str = ""
    agent_api_key: SecretStr = SecretStr("")
    agent_timeout_seconds: int = 180
    agent_max_rounds: int = 8
    agent_settings_path: Path | None = None
    agent_world_url: str = "http://127.0.0.1:4173"
    agent_access_token: SecretStr = SecretStr("")
    agent_browser_origin: str = ""
    prompt_enhancement_enabled: bool = False
    prompt_enhancement_base_url: str = "https://api.minimax.cn"
    prompt_enhancement_model: str = "MiniMax-H3"
    prompt_enhancement_api_key: SecretStr = SecretStr("")
    prompt_enhancement_timeout_seconds: int = 300
    prompt_enhancement_poll_seconds: float = 3
