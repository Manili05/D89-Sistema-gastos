from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    app_timezone: str = "America/Mexico_City"
    app_currency: str = "MXN"
    database_url: str = "postgresql://postgres:postgres@localhost:5432/d89"
    jwt_secret: str = Field(default="development-only-change-me-32-bytes")
    hermes_hmac_key_id: str = "hermes-staging"
    hermes_hmac_secret: str = Field(default="development-hmac-secret-change-me")
    neodata_max_bytes: int = 10 * 1024 * 1024
    hmac_tolerance_seconds: int = 300
    hermes_sandbox_mode: bool = True
    # AI extraction goes through the LiteLLM proxy with a budgeted virtual key.
    # Model names are LiteLLM aliases so the provider stays swappable by config.
    litellm_base_url: str = "http://litellm:4000/v1"
    litellm_api_key: str = ""
    ai_csf_model: str = "d89-documentos"
    ai_receipt_model: str = "d89-vision"
    ai_timeout_seconds: float = 60
    ai_max_upload_bytes: int = 10 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
