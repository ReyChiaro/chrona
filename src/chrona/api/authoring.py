from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import LocalizedJSONResponse, install_i18n
from chrona.infrastructure.i18n import msg
import uuid
from fastapi import APIRouter, FastAPI, HTTPException, Request, Response
from pydantic import ValidationError
from chrona.infrastructure.config import Settings
from chrona.infrastructure.events import EventJournal
from chrona.authoring.agents.manager import SceneAgentManager
from chrona.authoring.agents.settings import AgentUpdate
from chrona.authoring.agents.client import test_connection
from chrona.authoring.agents.access import COOKIE, SESSION_SECONDS


def authoring_routes(agents, journal):
    app = APIRouter()

    def config_error(error):
        return (
            "; ".join(e["msg"] for e in error.errors(include_input=False))
            if isinstance(error, ValidationError)
            else error_message(error)
        )

    @app.get("/api/render/content/agent/status")
    def agent_status(request: Request):
        value = agents.store.snapshot()
        return {
            "mode": value.mode,
            "model": value.model if value.mode == "api" else "",
            "configured": value.configured,
            "unlocked": agents.access.authorized(request),
            "protocol": "chat-completions",
        }

    @app.post("/api/render/content/agent/unlock")
    def agent_unlock(data: dict, response: Response, request: Request):
        agents.access.check_origin(request)
        session = agents.access.unlock(data.get("accessToken"))
        response.set_cookie(
            COOKIE,
            session,
            max_age=SESSION_SECONDS,
            httponly=True,
            samesite="strict",
            path="/api/",
        )
        return {"unlocked": True}

    @app.post("/api/render/content/agent/lock")
    def agent_lock(response: Response, request: Request):
        agents.access.check_origin(request)
        response.delete_cookie(COOKIE, path="/api/")
        return {"unlocked": False}

    @app.get("/api/render/content/agent")
    def agent_settings(request: Request):
        agents.access.require(request)
        return agents.store.snapshot().public()

    @app.put("/api/render/content/agent")
    def agent_configure(data: dict, request: Request):
        agents.access.require(request)
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
        agents.access.require(request)
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
            if status["mode"] == "api":
                agents.access.require(request)
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
            agents.access.check_origin(request)
            if agents.store.snapshot().mode == "api":
                agents.access.require(request)
            result = agents.run(
                data, authorized=agents.access.authorized(request)
            )
            journal.emit(
                "content.edit.planned",
                msg("backend.api.authoring.scene-edit-planning-complete"),
                mode=result["mode"],
                trace=result["trace"],
                plan=result.get("plan"),
            )
            return result
        except PermissionError as error:
            raise HTTPException(401, error_message(error)) from error
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
    app.include_router(authoring_routes(agents, journal))

    @app.get("/api/authoring/health")
    def health():
        return {"status": "ok", "mode": agents.store.snapshot().mode}

    return app
