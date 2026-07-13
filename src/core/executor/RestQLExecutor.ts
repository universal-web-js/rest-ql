import { Logger } from '../utils/Logger'
import { NetworkError } from '../validation/errors'
import {
  HttpMethod,
  RestQLExecutorOptions,
  ParsedQuery,
  SchemaResource,
  VariableValues
} from '../types'

/**
 * RestQLExecutor class for executing REST queries based on provided schemas and variables.
 * @extends Logger
 */
export class RestQLExecutor extends Logger {
  private apiBaseUrls: { [key: string]: string }
  private defaultHeaders: { [key: string]: string }

  /**
   * Creates an instance of RestQLExecutor.
   * @param {RestQLExecutorOptions} options - Configuration options for the executor
   */
  constructor ({ baseUrls, headers }: RestQLExecutorOptions) {
    super('RestQLExecutor')
    this.apiBaseUrls = baseUrls
    this.defaultHeaders = headers
  }

  /**
   * Executes a REST query based on the provided parameters.
   * @param {ParsedQuery} parsedQuery - The parsed query object
   * @param {SchemaResource} resourceSchema - The schema for the resource being queried
   * @param {VariableValues} variableValues - Values for variables used in the query
   * @param {HttpMethod} httpMethod - The HTTP method to be used for the request
   * @returns {Promise<any>} The response data from the API
   * @throws {Error} If the endpoint is not found or if the network request fails
   */
  async execute (
    parsedQuery: ParsedQuery,
    resourceSchema: SchemaResource,
    variableValues: VariableValues,
    httpMethod: HttpMethod
  ): Promise<any> {
    this.log('Executing query:', {
      parsedQuery,
      resourceSchema,
      variableValues,
      httpMethod
    })

    const endpointConfig = this.getEndpointConfig(resourceSchema, httpMethod, parsedQuery.queryName)
    const fullUrl = this.constructFullUrl(endpointConfig.path, variableValues)
    const resolvedQueryArgs = this.resolveQueryArguments(parsedQuery.args, variableValues)

    const apiResponse = await this.performApiRequest(fullUrl, httpMethod, resolvedQueryArgs)
    return apiResponse.json()
  }

  /**
   * Retrieves the endpoint configuration for the given method and resource.
   * @param {SchemaResource} resourceSchema - The schema for the resource
   * @param {HttpMethod} httpMethod - The HTTP method for the endpoint
   * @param {string} queryName - The name of the query
   * @returns {any} The endpoint configuration
   * @throws {Error} If no endpoint is found for the given method and resource
   * @private
   */
  private getEndpointConfig (resourceSchema: SchemaResource, httpMethod: HttpMethod, queryName: string): any {
    const endpointConfig = resourceSchema.endpoints[httpMethod]
    if (!endpointConfig) {
      const errorMessage = `No ${httpMethod} endpoint found for resource "${queryName}".`
      this.error(errorMessage)
      throw new Error(errorMessage)
    }
    return endpointConfig
  }

  /**
   * Constructs the full URL for the API request.
   * @param {string} pathTemplate - The path template from the endpoint configuration
   * @param {Object} variableValues - Values for variables to be inserted into the path
   * @returns {string} The fully constructed URL
   * @private
   */
  private constructFullUrl (pathTemplate: string, variableValues: { [key: string]: any }): string {
    this.log('Constructing URL from template:', { pathTemplate, variableValues })

    const baseUrl = this.getBaseUrl(pathTemplate)
    let fullUrl = this.combineBaseAndPath(baseUrl, pathTemplate)

    fullUrl = this.replacePathVariables(fullUrl, variableValues)
    fullUrl = this.removeTrailingSlashes(fullUrl)

    this.log('Constructed URL:', fullUrl)
    return fullUrl
  }

  /**
   * Retrieves the base URL for the given path.
   * @param {string} path - The path for which to find the base URL
   * @returns {string} The base URL
   * @throws {Error} If no base URL is found and no default is provided
   * @private
   */
  private getBaseUrl (path: string): string {
    const baseUrl = this.apiBaseUrls[path] || this.apiBaseUrls.default
    if (!baseUrl) {
      const errorMessage = `No base URL found for path: ${path} and no default URL provided`
      this.error(errorMessage)
      throw new Error(errorMessage)
    }
    return baseUrl
  }

  /**
   * Combines the base URL and path, ensuring proper formatting.
   * @param {string} baseUrl - The base URL
   * @param {string} path - The path to append to the base URL
   * @returns {string} The combined URL
   * @private
   */
  private combineBaseAndPath (baseUrl: string, path: string): string {
    return baseUrl.endsWith('/') || path.startsWith('/')
      ? baseUrl + path
      : baseUrl + '/' + path
  }

  /**
   * Replaces path variables with their corresponding values.
   * @param {string} url - The URL with path variables
   * @param {Object} variables - The values to replace variables with
   * @returns {string} The URL with variables replaced
   * @private
   */
  private replacePathVariables (url: string, variables: { [key: string]: any }): string {
    return url.replace(/{(\w+)}/g, (_, key) =>
      variables[key] !== undefined ? encodeURIComponent(variables[key]) : ''
    )
  }

  /**
   * Removes any trailing slashes from the URL.
   * @param {string} url - The URL to process
   * @returns {string} The URL without trailing slashes
   * @private
   */
  private removeTrailingSlashes (url: string): string {
    return url.replace(/\/+$/, '')
  }

  /**
   * Resolves query arguments, replacing variable references with their values.
   * @param {Object} args - The original query arguments
   * @param {Object} variableValues - The values for variables
   * @returns {Object} The resolved query arguments
   * @private
   */
  private resolveQueryArguments (args: { [key: string]: any }, variableValues: { [key: string]: any }): { [key: string]: any } {
    const resolvedArgs: { [key: string]: any } = {}
    for (const [key, value] of Object.entries(args)) {
      resolvedArgs[key] = typeof value === 'string' && value.startsWith('$')
        ? variableValues[value.slice(1)]
        : value
    }
    return resolvedArgs
  }

  /**
   * Performs the actual API request.
   * @param {string} url - The full URL for the request
   * @param {HttpMethod} httpMethod - The HTTP method to use
   * @param {Object} queryArgs - The query arguments
   * @returns {Promise<Response>} The response from the API
   * @throws {NetworkError} If the request fails
   * @private
   */
  private async performApiRequest (
    url: string,
    httpMethod: HttpMethod,
    queryArgs: any
  ): Promise<Response> {
    const requestOptions: RequestInit = this.prepareRequestOptions(httpMethod, queryArgs)

    if (httpMethod === HttpMethod.GET) {
      url = this.appendQueryString(url, queryArgs)

      // In-flight deduplication (GET only): identical concurrent requests
      // share a single network call. Each consumer receives a clone so the
      // body can be read independently. Mutations are never deduplicated.
      const dedupKey = `${httpMethod} ${url}`
      const inFlight = this.inFlightRequests.get(dedupKey)
      if (inFlight) {
        this.log(`Deduplicated in-flight request: ${dedupKey}`)
        const sharedResponse = await inFlight
        return this.assertOk(sharedResponse.clone(), url)
      }

      this.log(`Sending ${httpMethod} request to ${url}`)
      const pending = fetch(url, requestOptions)
      this.inFlightRequests.set(dedupKey, pending)
      try {
        const response = await pending
        return this.assertOk(response.clone(), url)
      } finally {
        this.inFlightRequests.delete(dedupKey)
      }
    }

    this.log(`Sending ${httpMethod} request to ${url}`)
    const response = await fetch(url, requestOptions)
    return this.assertOk(response, url)
  }

  private readonly inFlightRequests = new Map<string, Promise<Response>>()

  private assertOk (response: Response, url: string): Response {
    if (!response.ok) {
      const errorMessage = `Request to ${url} failed with status ${response.status}`
      this.error(errorMessage)
      throw new NetworkError(errorMessage)
    }
    return response
  }

  /**
   * Prepares the options for the fetch request.
   * @param {HttpMethod} httpMethod - The HTTP method for the request
   * @param {Object} queryArgs - The query arguments
   * @returns {RequestInit} The prepared request options
   * @private
   */
  private prepareRequestOptions (httpMethod: HttpMethod, queryArgs: any): RequestInit {
    const options: RequestInit = {
      method: httpMethod,
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/json'
      }
    }

    if (httpMethod !== HttpMethod.GET && Object.keys(queryArgs).length > 0) {
      options.body = JSON.stringify(
        Object.fromEntries(
          Object.entries(queryArgs).filter(([_, v]) => v !== undefined)
        )
      )
    }

    return options
  }

  /**
   * Appends query string to the URL for GET requests.
   * @param {string} url - The base URL
   * @param {Object} queryArgs - The query arguments to append
   * @returns {string} The URL with appended query string
   * @private
   */
  private appendQueryString (url: string, queryArgs: any): string {
    const queryParams = new URLSearchParams()
    for (const [key, value] of Object.entries(queryArgs)) {
      if (value !== undefined) {
        queryParams.append(key, value.toString())
      }
    }
    const queryString = queryParams.toString()
    return queryString ? `${url}?${queryString}` : url
  }
}
