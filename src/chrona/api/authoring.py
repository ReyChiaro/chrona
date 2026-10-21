from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import LocalizedJSONResponse, install_i18n
from chrona.infrastructure.i18n import msg
import uuid
from fastapi import APIRouter, FastAPI, HTTPException, Request
from pydantic import ValidationError
from chrona.infrastructure.config import Settings
from chrona.infrastructure.events import EventJournal
from chrona.authoring.agents.manager import SceneAgentManager
from chrona.authoring.agents.settings import AgentUpdate
from chrona.authoring.agents.client import test_connection
from chrona.infrastructure.browser_origin import BrowserOriginGuard


def authoring_routes(agents, journal, check_origin):
    app = APIRouter()

    def config_error(error):
        return (
            "; ".join(e["msg"] for e in error.errors(include_input=False))
            if isinstance(error, ValidationError)
            else error_message(error)
        )

    @app.get("/api/render/content/agent/status")
    def agent_status():
        value = agents.store.snapshot()
        return {
            "mode": value.mode,
            "model": value.model if value.mode == "api" else "",
            "configured": value.configured,
            "protocol": "chat-completions",
        }

    @app.get("/api/render/content/agent")
    def agent_settings(request: Request):
        check_origin(request)
        return agents.store.snapshot().public()

    @app.put("/api/render/content/agent")
    def agent_configure(data: dict, request: Request):
        check_origin(request)
        try:
            value = agents.store.save(AgentUpdate.model_validate(data))
            journal.emit(
                "agent.configured",
                msg("backend.api.authoring.code-agent-settings-saved"),
                mode=value["mode"],
                model=value["model"],
                baseUrl=value["baseUrl"],
            )
            return value
        except ValueError as error:
            raise HTTPException(400, config_error(error)) from error

    @app.post("/api/render/content/agent/test")
    def agent_test(data: dict, request: Request):
        check_origin(request)
        config = None
        try:
            config = agents.store.prepare(AgentUpdate.model_validate(data))
            journal.emit(
                "agent.connection.started",
                msg(
                    "backend.api.authoring.testing-the-code-model-connection-and-tool-calling"
                ),
                model=config.model,
                baseUrl=config.base_url,
            )
            result = test_connection(config)
            journal.emit(
                "agent.connection.succeeded",
                msg(
                    "backend.api.authoring.code-model-connection-and-tool-calling-test-succeeded"
                ),
                **result,
            )
            return result
        except ValueError as error:
            message = config_error(error)
            journal.emit(
                "agent.connection.failed",
                msg("backend.api.authoring.code-model-connection-test-failed"),
                level="error",
                error=message,
                model=config.model if config else None,
                baseUrl=config.base_url if config else None,
                httpStatus=getattr(error, "status_code", None),
            )
            raise HTTPException(400, message) from error

    @app.get("/api/render/content/agent/runs/{identifier}")
    def agent_progress(identifier: uuid.UUID, request: Request):
        try:
            status = agents.status(str(identifier))
            check_origin(request)
            return status
        except KeyError as error:
            raise HTTPException(
                404,
                msg(
                    "backend.api.authoring.the-agent-request-has-not-started-or-its-record"
                ),
            ) from error

    @app.post("/api/render/content/edit")
    def content_edit(data: dict, request: Request):
        try:
            check_origin(request)
            result = agents.run(data)
            journal.emit(
                "content.edit.planned",
                msg("backend.api.authoring.scene-edit-planning-complete"),
                mode=result["mode"],
                trace=result["trace"],
                plan=result.get("plan"),
            )
            return result
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(400, error_message(error)) from error

    return app


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    journal = EventJournal(settings.data_dir.resolve())
    agents = SceneAgentManager(settings, journal)
    app = FastAPI(
        title="Chrona Authoring", default_response_class=LocalizedJSONResponse
    )
    install_i18n(app)
    app.state.agents = agents
    check_origin = BrowserOriginGuard(
        settings.agent_browser_origin or settings.agent_world_url
    )
    app.include_router(authoring_routes(agents, journal, check_origin))

    @app.get("/api/authoring/health")
    def health():
        return {"status": "ok", "mode": agents.store.snapshot().mode}

    return app
