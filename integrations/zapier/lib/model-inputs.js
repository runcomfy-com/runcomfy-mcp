const Ajv = require('ajv');
const { request, modelPath, objectResponse, isObject, parseObject } = require('./api');
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const inputKey = (name) => `input_${Buffer.from(name).toString('hex')}`;
const getModel = async (z, bundle) => objectResponse(await request(z, bundle, 'model', `/v1/models/${modelPath(bundle.inputData.model_id)}`));

const inputSchema = (model) => {
  if (!isObject(model.input_schema) || !isObject(model.input_schema.properties)) {
    throw new Error('This model does not provide a usable input schema. Choose another model or check its RunComfy API page.');
  }
  return model.input_schema;
};

const modelFields = async (z, bundle) => {
  if (!bundle.inputData.model_id) return [];
  const model = await getModel(z, bundle);
  const schema = inputSchema(model);
  const required = new Set(schema.required || model.required_inputs || []);
  return Object.entries(schema.properties).map(([name, property]) => {
    const types = Array.isArray(property.type) ? property.type.filter((type) => type !== 'null') : [property.type];
    const type = types.length === 1 ? types[0] : undefined;
    const field = {
      key: inputKey(name), label: property.title || name.replaceAll('_', ' '), required: required.has(name),
      type: { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', object: 'text', array: 'text' }[type] || 'text',
      helpText: `${property.description || `Model input: ${name}.`}${['object', 'array'].includes(type) || !type ? ' Enter valid JSON for this structured input.' : ''}${property.minimum != null ? ` Minimum: ${property.minimum}.` : ''}${property.maximum != null ? ` Maximum: ${property.maximum}.` : ''}`,
    };
    if (Array.isArray(property.enum) && property.enum.every((item) => typeof item === 'string')) field.choices = property.enum;
    if (property.default !== undefined && property.default !== null) field.default = typeof property.default === 'object' ? JSON.stringify(property.default) : String(property.default);
    return field;
  });
};

const collectInputs = (model, inputData) => {
  const schema = inputSchema(model);
  const inputs = inputData.additional_inputs ? parseObject(inputData.additional_inputs, 'Additional Inputs') : {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const field = inputKey(name);
    if (!Object.hasOwn(inputData, field) || inputData[field] === undefined || inputData[field] === '') continue;
    if (Object.hasOwn(inputs, name)) throw new Error(`Provide ${name} in its own field or Additional Inputs, not both.`);
    let value = inputData[field];
    const types = Array.isArray(property.type) ? property.type.filter((type) => type !== 'null') : [property.type];
    if (types.length !== 1 || !['string', 'integer', 'number', 'boolean'].includes(types[0])) {
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw new Error(`${name} must contain valid JSON.`); }
      }
    }
    inputs[name] = value;
  }
  let validate;
  try { validate = ajv.compile(schema); } catch { throw new Error('This model input schema cannot be validated. No request was submitted.'); }
  if (!validate(inputs)) {
    const errors = validate.errors.map((error) => `${error.instancePath || 'Inputs'} ${error.message}${error.params.missingProperty ? `: ${error.params.missingProperty}` : ''}`).join('; ');
    throw new Error(`Model input validation failed: ${errors}. No request was submitted.`);
  }
  return inputs;
};
module.exports = { getModel, modelFields, collectInputs, inputKey };
