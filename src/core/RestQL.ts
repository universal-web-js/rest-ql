import { Logger } from './utils/Logger'
import { RestQLParser } from './parser/Parser'
import {
  Schema,
  BaseUrls,
  RestQLOptions,
  ParsedOperation,
  VariableValues,
  HttpMethod,
  ParsedQuery,
  SchemaResource,
  ValueType
} from './types'
import { SDLParser } from './parser/SDLParser'
import { CacheManager } from './cache/CacheManager'
import { BatchManager } from './batch/BatchManager'
import { RestQLExecutor } from './executor/RestQLExecutor'
import { ValidationError } from './validation/errors'
import { SchemaValidator } from './validation/SchemaValidator'
import lodashGet from 'lodash.get'

/**
 * RestQL class for executing and managing REST API queries.
 * @extends Logger
 */
export class RestQL extends Logger {
  private schema: Schema
  private baseUrls: BaseUrls
  private options: Required<RestQLOptions>
  private sdlParser: SDLParser
  private queryParser: RestQLParser
  private cacheManager: CacheManager
  private batchManager: BatchManager
  private executor: RestQLExecutor
  private transformers: { [key: string]: () => any }
  private schemaValidator: SchemaValidator
  private debugMode: boolean

  /**
   * Creates an instance of RestQL.
   * @param {string} sdl - The Schema Definition Language string
   * @param {BaseUrls} baseUrls - The base URLs for API endpoints
   * @param {RestQLOptions} [options={}] - Configuration options for RestQL
   * @param {{ [key: string]: () => any }} [transformers={}] - Custom transformer functions
   * @param {boolean} [debugMode=false] - Whether to enable debug mode
   */
  constructor (
    sdl: string,
    baseUrls: BaseUrls,
    options: RestQLOptions = {},
    transformers: { [key: string]: () => any } = {},
    debugMode = false
  ) {
    super('RestQL', debugMode)
    this.baseUrls = baseUrls
    this.options = {
      cacheTimeout: 5 * 60 * 1000,
      headers: {},
      maxRetries: 3,
      retryDelay: 1000,
      batchInterval: 50,
      maxBatchSize: Infinity,
      ...options
    }
    this.debugMode = debugMode

    this.initializeComponents(sdl, transformers)
  }

  /**
   * Executes a RestQL operation.
   * @param {string} operationString - The operation string to execute
   * @param {{ [key: string]: any }} [variables={}] - Variables for the operation
   * @param {{ useCache?: boolean }} [options={}] - Execution options
   * @returns {Promise<any | any[]>} The result of the operation
   * @throws {ValidationError} If the operation type is unsupported
   */
  async execute (
    operationString: string,
    variables: { [key: string]: any } = {},
    options: { useCache?: boolean } = {}
  ): Promise<any | any[]> {
    this.log('Execute called with:', {
      operationString,
      variables,
      options
    })
    const parsedOperation = this.queryParser.parse(operationString)
    this.log('Parsed operation:', parsedOperation)

    const definedVariables = this.filterDefinedVariables(variables)
    this.log('Defined variables:', definedVariables)

    this.validateVariables(parsedOperation.variables, definedVariables)

    if (parsedOperation.operationType === 'query') {
      const result = await this.executeQuery(
        parsedOperation,
        definedVariables,
        options.useCache ?? true
      )
      return result
    } else if (parsedOperation.operationType === 'mutation') {
      this.log('Executing mutation')
      const result = await this.executeMutation(
        parsedOperation,
        definedVariables
      )
      this.log('Mutation result:', result)
      return result
    } else {
      throw new ValidationError(
        `Unsupported operation type: ${parsedOperation.operationType}`
      )
    }
  }

  /**
   * Validates the provided variables against the declared variables.
   * @param {{ [key: string]: VariableDefinition }} declaredVariables - The variables declared in the operation
   * @param {{ [key: string]: any }} providedVariables - The variables provided for execution
   * @throws {ValidationError} If a required variable is not provided
   * @private
   */
  private validateVariables (
    declaredVariables: { [key: string]: VariableDefinition },
    providedVariables: { [key: string]: any }
  ): void {
    this.log('Validating variables:')
    this.log('Declared variables:', declaredVariables)
    this.log('Provided variables:', providedVariables)

    for (const [varName, varDef] of Object.entries(declaredVariables)) {
      this.log(`Checking variable: ${varName}, required: ${varDef.isRequired}`)
      if (varDef.isRequired && !(varName in providedVariables)) {
        this.log(`Required variable ${varName} is not provided`)
        throw new ValidationError(
          `Required variable ${varName} is not provided`
        )
      }
    }
    this.log('Variable validation completed successfully')
  }

  /**
   * Executes a query operation.
   * @param {ParsedOperation} parsedOperation - The parsed query operation
   * @param {VariableValues} variables - The variables for the query
   * @param {boolean} useCache - Whether to use caching
   * @returns {Promise<{ shapedData: any; rawResponses: { [key: string]: any } }>} The query results
   * @private
   */
  private async executeQuery (
    parsedOperation: ParsedOperation,
    variables: VariableValues,
    useCache: boolean
  ): Promise<{ shapedData: any; rawResponses: { [key: string]: any } }> {
    const results: any = {}
    const rawResponses: { [key: string]: any } = {}
    const batchPromises: Promise<void>[] = []

    for (const query of parsedOperation.queries) {
      const resourceSchema = this.schema[query.queryName.toLowerCase()]
      if (!resourceSchema) {
        throw new Error(`Resource "${query.queryName}" not found in schema.`)
      }

      const cacheKey = this.getCacheKey(query.queryName, query.args, variables)
      if (useCache && this.cacheManager.has(cacheKey)) {
        const cachedResult = this.cacheManager.get(cacheKey)
        results[query.queryName] = cachedResult.shapedData
        rawResponses[query.queryName] = cachedResult.rawResponse
      } else {
        batchPromises.push(
          this.batchManager.add(query.queryName, async () => {
            const result = await this.executeQueryField(
              query.queryName,
              query.fields,
              query.args,
              variables,
              resourceSchema
            )
            results[query.queryName] = result.shapedData
            rawResponses[query.queryName] = result.rawResponse

            if (useCache) {
              this.cacheManager.set(cacheKey, result)
            }
          })
        )
      }
    }

    await Promise.all(batchPromises)
    return { shapedData: results, rawResponses }
  }

  /**
   * Executes a mutation operation.
   * @param {ParsedOperation} parsedOperation - The parsed mutation operation
   * @param {VariableValues} variables - The variables for the mutation
   * @returns {Promise<any[]>} The mutation results
   * @private
   */
  private async executeMutation (
    parsedOperation: ParsedOperation,
    variables: VariableValues
  ): Promise<any[]> {
    this.log('executeMutation called with:', { parsedOperation, variables })
    const results: any[] = []
    const batchPromises: Promise<void>[] = []

    for (const mutation of parsedOperation.queries) {
      this.log('Processing mutation:', mutation)
      batchPromises.push(
        this.batchManager.add(mutation.queryName, async () => {
          const [operationType, resourceName] = this.parseMutationType(
            mutation.queryName
          )
          const resourceSchema = this.schema[resourceName.toLowerCase()]
          if (!resourceSchema) {
            throw new Error(`Resource "${resourceName}" not found in schema.`)
          }

          const method = this.getHttpMethodForOperation(operationType)
          const endpoint = resourceSchema.endpoints[method]
          if (!endpoint) {
            throw new Error(
              `${method} endpoint not found for resource "${resourceName}".`
            )
          }

          const result = await this.executor.execute(
            mutation,
            resourceSchema,
            variables,
            method
          )
          const dataPath = resourceSchema.dataPath || ''
          const extractedData = this.extractNestedValue(result, dataPath)
          const shapedResult = await this.shapeData(
            extractedData,
            mutation,
            resourceSchema,
            variables
          )

          this.log('Shaped result before cherry-picking:', shapedResult)
          const pickedResult = this.cherryPickFields(
            shapedResult,
            mutation.fields
          )
          this.log('Cherry-picked result:', pickedResult)
          results.push(pickedResult)
        })
      )
    }

    await Promise.all(batchPromises)
    return results
  }

  /**
   * Parses the mutation type from the mutation name.
   * @param {string} mutationName - The name of the mutation
   * @returns {[string, string]} The operation type and resource name
   * @throws {Error} If the mutation type is unknown
   * @private
   */
  private parseMutationType (mutationName: string): [string, string] {
    const operationTypes = ['create', 'update', 'patch', 'delete']
    for (const opType of operationTypes) {
      if (mutationName.toLowerCase().startsWith(opType)) {
        return [opType, mutationName.slice(opType.length)]
      }
    }
    throw new Error(`Unknown mutation type: ${mutationName}`)
  }

  /**
   * Gets the HTTP method for a given operation type.
   * @param {string} operationType - The type of operation
   * @returns {HttpMethod} The corresponding HTTP method
   * @throws {Error} If the operation type is unsupported
   * @private
   */
  private getHttpMethodForOperation (operationType: string): HttpMethod {
    switch (operationType) {
      case 'create':
        return HttpMethod.POST
      case 'update':
        return HttpMethod.PUT
      case 'patch':
        return HttpMethod.PATCH
      case 'delete':
        return HttpMethod.DELETE
      default:
        throw new Error(`Unsupported operation type: ${operationType}`)
    }
  }

  /**
   * Cherry-picks fields from the data based on the requested fields.
   * @param {any} data - The data to pick fields from
   * @param {any} fields - The fields to pick
   * @returns {any} The picked data
   * @private
   */
  private cherryPickFields (data: any, fields: any): any {
    this.log('cherryPickFields called with:', { data, fields })

    if (typeof data !== 'object' || data === null) {
      this.log('cherryPickFields result (non-object):', data)
      return data
    }

    const result: any = {}

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      this.log(`Processing field: ${fieldName}`, {
        fieldValue,
        dataValue: data[fieldName]
      })

      if (typeof fieldValue === 'object' && fieldValue !== null) {
        if (fieldValue.value === true) {
          result[fieldName] = data[fieldName]
        } else if (fieldValue.fields) {
          if (Array.isArray(data[fieldName])) {
            result[fieldName] = data[fieldName].map((item: any) =>
              this.cherryPickFields(item, fieldValue.fields)
            )
          } else if (
            typeof data[fieldName] === 'object' &&
            data[fieldName] !== null
          ) {
            result[fieldName] = this.cherryPickFields(
              data[fieldName],
              fieldValue.fields
            )
          } else {
            result[fieldName] = data[fieldName]
          }
        }
      } else if (fieldValue === true) {
        result[fieldName] = data[fieldName]
      }

      this.log(`Field ${fieldName} result:`, result[fieldName])
    }

    this.log('cherryPickFields result:', result)
    return result
  }

  /**
   * Shapes the data according to the schema and requested fields.
   * @param {any} data - The raw data to shape
   * @param {ParsedQuery} query - The parsed query
   * @param {SchemaResource | ValueType} resourceSchema - The schema for the resource
   * @param {VariableValues} variables - The variables for the query
   * @param {{ [key: string]: any }} [rawResponses={}] - The raw responses
   * @returns {Promise<any>} The shaped data
   * @private
   */
  private async shapeData (
    data: any,
    query: ParsedQuery,
    resourceSchema: SchemaResource | ValueType,
    variables: VariableValues,
    rawResponses: { [key: string]: any } = {}
  ): Promise<any> {
    if (Array.isArray(data)) {
      return Promise.all(
        data.map((item) =>
          this.shapeData(item, query, resourceSchema, variables, rawResponses)
        )
      )
    }

    const shapedData: any = {}

    // Sibling fields resolve concurrently; dependency chains remain ordered by
    // recursion (a nested resource's own fields resolve inside its subtree).
    // Results are assigned in declaration order to keep output key order stable.
    const fieldResults = await Promise.all(
      Object.entries(query.fields).map(
        async ([fieldName, fieldValue]): Promise<[string, any] | null> => {
          const fieldSchema = resourceSchema.fields?.[fieldName]
          if (!fieldSchema) {
            this.warn(
              `Field schema for "${fieldName}" not found in resource schema. Skipping.`
            )
            return null
          }

          const fromPath = fieldSchema.from || fieldName
          let rawValue = this.extractNestedValue(data, fromPath)

          try {
            // Apply type coercion and nullability check
            rawValue = this.coerceValue(rawValue, fieldSchema)

            if (
              fieldSchema.isResource ||
              this.schema[fieldSchema.type.toLowerCase()]
            ) {
              const nestedResourceSchema =
                this.schema[fieldSchema.type.toLowerCase()]
              if (nestedResourceSchema) {
                const nestedQuery = {
                  queryName: fieldName,
                  args: fieldValue.args || {},
                  fields: fieldValue.fields
                }
                const nestedResult = await this.executeQueryField(
                  fieldName,
                  nestedQuery.fields,
                  nestedQuery.args,
                  variables,
                  nestedResourceSchema
                )
                rawValue = nestedResult.shapedData
              }
            } else if (typeof fieldValue === 'object' && fieldValue.fields) {
              const nestedType = fieldSchema.type.replace(/[\[\]!]/g, '')
              const nestedSchema = this.schema._types[nestedType]
              if (nestedSchema) {
                rawValue = await this.shapeData(
                  rawValue,
                  { fields: fieldValue.fields },
                  nestedSchema,
                  variables,
                  rawResponses
                )
              } else {
                this.warn(`Schema not found for nested type: ${nestedType}`)
              }
            }

            if (
              fieldSchema.transform &&
              this.transformers[fieldSchema.transform]
            ) {
              rawValue = this.transformers[fieldSchema.transform](
                data,
                { [fieldName]: rawValue },
                rawResponses
              )
            }

            return [fieldName, rawValue]
          } catch (error) {
            if (error instanceof ValidationError) {
              this.error(
                `Validation error for field ${fieldName}:`,
                error.message
              )
              if (!fieldSchema.isNullable) {
                throw error
              }
              return [fieldName, null]
            } else {
              throw error
            }
          }
        }
      )
    )

    for (const entry of fieldResults) {
      if (entry) {
        shapedData[entry[0]] = entry[1]
      }
    }

    if (
      'transform' in resourceSchema &&
      resourceSchema.transform &&
      this.transformers[resourceSchema.transform]
    ) {
      return this.transformers[resourceSchema.transform](
        data,
        shapedData,
        rawResponses
      )
    }

    return shapedData
  }

  /**
   * Coerces a value to the specified type according to the field schema.
   * @param {any} value - The value to coerce
   * @param {SchemaField} fieldSchema - The schema for the field
   * @returns {any} The coerced value
   * @throws {ValidationError} If the value cannot be coerced or is null for a non-nullable field
   * @private
   */
  private coerceValue (value: any, fieldSchema: SchemaField): any {
    const { type, isNullable } = fieldSchema

    if (value === null || value === undefined) {
      if (!isNullable) {
        throw new ValidationError(
          'Non-nullable field received null or undefined value'
        )
      }
      return null
    }

    const baseType = type.replace(/[\[\]!]/g, '')

    switch (baseType) {
      case 'Boolean':
        return Boolean(value)
      case 'String':
        return String(value)
      case 'Int':
        const num = Number(value)
        if (isNaN(num) || !Number.isInteger(num)) {
          throw new ValidationError(`Invalid integer value: ${value}`)
        }
        return num
      default:
        // For custom types, we don't perform any coercion
        return value
    }
  }

  /**
   * Executes a query for a specific field.
   * @param {string} fieldName - The name of the field
   * @param {any} fields - The fields to retrieve
   * @param {any} args - The arguments for the query
   * @param {VariableValues} variables - The variables for the query
   * @param {SchemaResource} resourceSchema - The schema for the resource
   * @returns {Promise<{ shapedData: any; rawResponse: any }>} The query result
   * @throws {Error} If the endpoint is not found or if there's an error during execution
   * @private
   */
  private async executeQueryField (
    fieldName: string,
    fields: any,
    args: any,
    variables: VariableValues,
    resourceSchema: SchemaResource
  ): Promise<{ shapedData: any; rawResponse: any }> {
    this.log('Executing query field:', {
      fieldName,
      fields,
      args,
      variables
    })

    if (!resourceSchema.endpoints) {
      this.error(`No endpoints defined for resource "${fieldName}".`)
      throw new Error(`No endpoints defined for resource "${fieldName}".`)
    }

    if (!resourceSchema.endpoints.GET) {
      this.error(`GET endpoint not found for resource "${fieldName}".`)
      throw new Error(`GET endpoint not found for resource "${fieldName}".`)
    }

    const endpoint = resourceSchema.endpoints.GET
    const resolvedArgs = this.resolveVariables(args, variables)

    try {
      const result = await this.executor.execute(
        { queryName: fieldName, fields, args: resolvedArgs },
        resourceSchema,
        variables,
        HttpMethod.GET
      )

      const dataPath = resourceSchema.dataPath || ''
      const extractedData = this.extractNestedValue(result, dataPath)

      const shapedResult = await this.shapeData(
        extractedData,
        { fields },
        resourceSchema,
        variables,
        { [fieldName]: result }
      )
      return { shapedData: shapedResult, rawResponse: result }
    } catch (error) {
      this.error(`Error executing query for ${fieldName}:`, error)
      throw error
    }
  }

  /**
   * Extracts a nested value from data using a dot-notated path.
   * @param {any} data - The data to extract from
   * @param {string} path - The dot-notated path to the desired value
   * @returns {any} The extracted value
   * @private
   */
  private extractNestedValue (data: any, path: string): any {
    return lodashGet(data, path)
  }

  /**
   * Shapes nested arrays according to the field schema.
   * @param {any[]} rawValue - The raw array value
   * @param {any} fieldValue - The field value from the query
   * @param {SchemaResource | ValueType} itemSchema - The schema for the array items
   * @param {string} fieldType - The type of the field
   * @returns {any[]} The shaped array
   * @private
   */
  private shapeNestedArrays (
    rawValue: any[],
    fieldValue: any,
    itemSchema: SchemaResource | ValueType,
    fieldType: string
  ): any[] {
    const nestedLevel = (fieldType.match(/\[/g) || []).length

    if (nestedLevel === 1) {
      const shapedArray = rawValue.map((item) =>
        this.shapeData(item, { fields: fieldValue }, itemSchema)
      )
      return shapedArray
    } else {
      const shapedArray = rawValue.map((item) =>
        this.shapeNestedArrays(
          item,
          fieldValue,
          itemSchema,
          fieldType.slice(1, -1)
        )
      )
      return shapedArray
    }
  }

  /**
   * Generates a cache key for a query.
   * @param {string} fieldName - The name of the field
   * @param {any} args - The arguments for the query
   * @param {VariableValues} variables - The variables for the query
   * @returns {string} The generated cache key
   * @private
   */
  private getCacheKey (
    fieldName: string,
    args: any,
    variables: VariableValues
  ): string {
    const resolvedArgs = this.resolveVariables(args, variables)
    return `${fieldName}:${JSON.stringify(resolvedArgs)}`
  }

  /**
   * Resolves variables in the arguments.
   * @param {{ [key: string]: string }} args - The arguments containing variable references
   * @param {{ [key: string]: any }} variables - The variables to resolve
   * @returns {{ [key: string]: any }} The resolved arguments
   * @private
   */
  private resolveVariables (
    args: { [key: string]: string },
    variables: { [key: string]: any }
  ): { [key: string]: any } {
    const resolved: { [key: string]: any } = {}
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const varName = value.slice(1)
        if (varName in variables) {
          resolved[key] = variables[varName]
        }
        // If the variable is not provided, we simply skip it
        // This allows optional variables to be omitted
      } else {
        resolved[key] = value
      }
    }
    return resolved
  }

  /**
   * Initializes the components of RestQL.
   * @param {string} sdl - The Schema Definition Language string
   * @param {{ [key: string]: () => any }} transformers - Custom transformer functions
   * @throws {Error} If there's an error parsing or validating the schema
   * @private
   */
  private initializeComponents (
    sdl: string,
    transformers: { [key: string]: () => any }
  ): void {
    this.sdlParser = new SDLParser(sdl)
    try {
      this.schema = this.sdlParser.parseSDL()
      this.schemaValidator = new SchemaValidator(transformers)
      this.schemaValidator.validateSchema(this.schema)
    } catch (error) {
      this.error('Error parsing or validating schema:', error)
      throw error
    }

    this.queryParser = new RestQLParser()
    this.cacheManager = new CacheManager(this.options.cacheTimeout)
    this.batchManager = new BatchManager(
      this.options.batchInterval,
      this.options.maxBatchSize
    )
    this.executor = new RestQLExecutor({
      baseUrls: this.baseUrls,
      headers: this.options.headers
    })
    this.transformers = transformers
  }

  /**
   * Filters out undefined variables from the provided variables object.
   * @param {{ [key: string]: any }} variables - The variables to filter
   * @returns {{ [key: string]: any }} The filtered variables
   * @private
   */
  private filterDefinedVariables (variables: { [key: string]: any }): {
    [key: string]: any;
  } {
    return Object.fromEntries(
      Object.entries(variables).filter(([_, value]) => value !== undefined)
    )
  }
}
