/**
 * Unit Tests: Configuration & Presets
 * @license Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_PRESETS, AelConfigSchema } from '../src/config/ael_config.js';
import fs from 'node:fs';

describe('Config System & Presets', () => {
  it('loads default configuration when no file path is provided', () => {
    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.active_preset).toBe('balanced');
    expect(config.presets.balanced).toBeDefined();
    expect(config.presets.quality_first).toBeDefined();
    expect(config.presets.cost_saver).toBeDefined();
    expect(config.presets.latency_capped).toBeDefined();
  });

  it('loads valid YAML configuration from disk', () => {
    const config = loadConfig('./ael_config.yaml');
    expect(config.provider.name).toBe('gemini-default');
    expect(config.circuit_breaker.enabled).toBe(true);
    expect(config.circuit_breaker.rolling_window).toBe(20);
    expect(config.telemetry.log_payloads).toBe(false);
  });

  it('validates preset properties correctly', () => {
    expect(DEFAULT_PRESETS.balanced.initial_reasoning_effort).toBe('low');
    expect(DEFAULT_PRESETS.quality_first.regime).toBe('sample');
    expect(DEFAULT_PRESETS.cost_saver.initial_reasoning_effort).toBe('none');
    expect(DEFAULT_PRESETS.latency_capped.max_latency_ms).toBe(2000);
  });

  it('rejects invalid configurations violating constraints', () => {
    expect(() =>
      AelConfigSchema.parse({
        port: -1,
        active_preset: 'invalid_preset',
      })
    ).toThrow();
  });
});
