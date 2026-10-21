"""JSON Schema adapters, generated model definitions share the canonical TS schema source."""
from copy import deepcopy
from typing import Any, Literal, Union
from pydantic import BaseModel, ConfigDict, create_model, model_validator
from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import ValidationError as SchemaError
from numbers import Real


def ordered_indices(validator, pairs, value, schema):
    if isinstance(value, (list, tuple)):
        for low, high in pairs:
            if max(low, high) < len(value) and all(isinstance(value[i], Real) and not isinstance(value[i], bool) for i in (low, high)) and value[low] > value[high]:
                yield SchemaError(f'Ordered indices required: {low} <= {high}')

SchemaValidator = validators.extend(Draft202012Validator, {'x-ordered': ordered_indices})

def defaults(schema, value):
    if isinstance(value, dict):
        value = deepcopy(value)
        for key, child in schema.get('properties', {}).items():
            if key not in value and 'default' in child:
                value[key] = deepcopy(child['default'])
            if key in value: value[key] = defaults(child, value[key])
    elif isinstance(value, list):
        value = [defaults(schema.get('items', {}), item) for item in value]
    return value


def build_models(schemas):
    cache = {}
    def annotation(schema, name):
        if 'const' in schema: return Literal[schema['const']]
        if 'enum' in schema: return Literal[tuple(schema['enum'])]
        if 'anyOf' in schema: return Union[tuple(annotation(s, name + str(i)) for i, s in enumerate(schema['anyOf']))]
        kind = schema.get('type')
        if isinstance(kind, list): return Union[tuple(annotation({**schema, 'type': item}, name + str(i)) for i, item in enumerate(kind))]
        if kind == 'object' and 'properties' in schema: return model(schema, name)
        if kind == 'object': return dict[str, annotation(schema.get('additionalProperties', {}), name + 'Value') if isinstance(schema.get('additionalProperties'), dict) else Any]
        if kind == 'array':
            if 'prefixItems' in schema: return tuple[tuple(annotation(s, name + str(i)) for i, s in enumerate(schema['prefixItems']))]
            return list[annotation(schema.get('items', {}), name + 'Item')]
        return {'string': str, 'number': float, 'integer': int, 'boolean': bool, 'null': type(None)}.get(kind, Any)
    def model(schema, name):
        if name in cache: return cache[name]
        validator = SchemaValidator(schema)
        class SchemaModel(BaseModel):
            model_config = ConfigDict(extra='forbid' if schema.get('additionalProperties') is False else 'ignore', allow_inf_nan=False)
            @model_validator(mode='before')
            @classmethod
            def validate_schema(cls, value):
                if isinstance(value, BaseModel): value = value.model_dump(mode='json', exclude_none=True)
                if not isinstance(value, dict): raise ValueError('Expected a protocol object')
                value = defaults(schema, value)
                # Optional None fields are omitted by Pydantic compatibility callers.
                value = {k: v for k, v in value.items() if v is not None or k in schema.get('required', []) or schema.get('properties', {}).get(k, {}).get('default', 1) is None}
                errors = sorted(validator.iter_errors(value), key=lambda e: str(e.path))
                if errors: raise ValueError(f'{list(errors[0].path)}: {errors[0].message}')
                return value
        fields = {}
        for key, child in schema.get('properties', {}).items():
            typ = annotation(child, name + key.title().replace('_', ''))
            default = deepcopy(child['default']) if 'default' in child else (... if key in schema.get('required', []) else None)
            if default is None: typ = Union[typ, type(None)]
            fields[key] = (typ, default)
        result = create_model(name, __base__=SchemaModel, **fields)
        cache[name] = result
        return result
    return {name: model(schema, name) for name, schema in schemas.items()}
