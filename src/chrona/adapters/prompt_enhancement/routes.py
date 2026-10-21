from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import msg
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import ValidationError

from chrona.adapters.prompt_enhancement.settings import EnhancementUpdate


def enhancement_routes(service, access, journal):
    router = APIRouter(prefix='/api/render/prompt-enhancement')

    def invalid(error):
        message = '; '.join(e['msg'] for e in error.errors(include_input=False)) if isinstance(error, ValidationError) else error_message(error)
        return HTTPException(400, message)

    @router.get('/status')
    def status(request: Request, response: Response):
        response.headers['Cache-Control'] = 'no-store'
        return {**service.capabilities(), 'unlocked': access.authorized(request)}

    @router.get('')
    def settings(request: Request, response: Response):
        access.require(request); response.headers['Cache-Control'] = 'no-store'
        return service.store.snapshot().public()

    @router.put('')
    def configure(data: dict, request: Request, response: Response):
        access.require(request); response.headers['Cache-Control'] = 'no-store'
        try:
            value = service.store.save(EnhancementUpdate.model_validate(data))
            journal.emit('prompt.enhancement.configured', msg('backend.adapters.prompt_enhancement.routes.prompt-enhancement-settings-saved'), configuration=value)
            return value
        except ValueError as error: raise invalid(error) from error

    @router.post('/test')
    def test(data: dict, request: Request, response: Response):
        access.require(request); response.headers['Cache-Control'] = 'no-store'
        try:
            config = service.store.prepare(EnhancementUpdate.model_validate(data))
            journal.emit('prompt.enhancement.test.started', msg('backend.adapters.prompt_enhancement.routes.testing-the-prompt-enhancement-service'), model=config.model, baseUrl=config.base_url)
            result = service.test(config)
            journal.emit('prompt.enhancement.test.succeeded', msg('backend.adapters.prompt_enhancement.routes.prompt-enhancement-connection-test-succeeded'), taskId=result['taskId'], latencyMs=result['latencyMs'])
            return result
        except (ValueError, TimeoutError) as error:
            journal.emit('prompt.enhancement.test.failed', msg('backend.adapters.prompt_enhancement.routes.prompt-enhancement-connection-test-failed'), level='error', error=error_message(error))
            raise invalid(error) from error

    return router
