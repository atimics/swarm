import { describe, it, expect } from 'vitest';
import { UpdateExpressionBuilder } from './dynamodb-expression.js';

describe('dynamodb-expression', () => {
  describe('UpdateExpressionBuilder', () => {
    it('should build a simple SET expression', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('name', 'John').build();

      expect(result.UpdateExpression).toBe('SET #n_name_0 = :v1');
      expect(result.ExpressionAttributeNames).toEqual({ '#n_name_0': 'name' });
      expect(result.ExpressionAttributeValues).toEqual({ ':v1': 'John' });
    });

    it('should build multiple SET expressions', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder
        .set('name', 'John')
        .set('age', 30)
        .set('email', 'john@example.com')
        .build();

      expect(result.UpdateExpression).toBe('SET #n_name_0 = :v1, #n_age_1 = :v2, #n_email_2 = :v3');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_name_0': 'name',
        '#n_age_1': 'age',
        '#n_email_2': 'email',
      });
      expect(result.ExpressionAttributeValues).toEqual({
        ':v1': 'John',
        ':v2': 30,
        ':v3': 'john@example.com',
      });
    });

    it('should build a simple REMOVE expression', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.remove('oldField').build();

      expect(result.UpdateExpression).toBe('REMOVE #n_oldField_0');
      expect(result.ExpressionAttributeNames).toEqual({ '#n_oldField_0': 'oldField' });
      expect(result.ExpressionAttributeValues).toEqual({});
    });

    it('should build multiple REMOVE expressions', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.remove('field1').remove('field2').build();

      expect(result.UpdateExpression).toBe('REMOVE #n_field1_0, #n_field2_1');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_field1_0': 'field1',
        '#n_field2_1': 'field2',
      });
      expect(result.ExpressionAttributeValues).toEqual({});
    });

    it('should build combined SET and REMOVE expressions', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('newField', 'value').remove('oldField').build();

      expect(result.UpdateExpression).toBe('SET #n_newField_0 = :v1 REMOVE #n_oldField_1');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_newField_0': 'newField',
        '#n_oldField_1': 'oldField',
      });
      expect(result.ExpressionAttributeValues).toEqual({ ':v1': 'value' });
    });

    it('should handle nested paths', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('user.profile.name', 'John').build();

      expect(result.UpdateExpression).toBe('SET #n_user_0.#n_profile_1.#n_name_2 = :v1');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_user_0': 'user',
        '#n_profile_1': 'profile',
        '#n_name_2': 'name',
      });
      expect(result.ExpressionAttributeValues).toEqual({ ':v1': 'John' });
    });

    it('should handle paths with spaces', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('user . profile . name', 'John').build();

      expect(result.UpdateExpression).toBe('SET #n_user_0.#n_profile_1.#n_name_2 = :v1');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_user_0': 'user',
        '#n_profile_1': 'profile',
        '#n_name_2': 'name',
      });
    });

    it('should handle empty paths gracefully', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('', 'value').build();

      expect(result.UpdateExpression).toBe('');
      expect(result.ExpressionAttributeNames).toEqual({});
      expect(result.ExpressionAttributeValues).toEqual({});
    });

    it('should handle paths with special characters', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('user-name', 'John').set('email@domain', 'test@test.com').build();

      expect(result.UpdateExpression).toContain('SET #n_user_name_0 = :v1, #n_email_domain_1 = :v2');
      expect(result.ExpressionAttributeNames['#n_user_name_0']).toBe('user-name');
      expect(result.ExpressionAttributeNames['#n_email_domain_1']).toBe('email@domain');
    });

    it('should reuse name keys for duplicate segments', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.set('user.name', 'John').set('user.age', 30).build();

      expect(result.UpdateExpression).toBe('SET #n_user_0.#n_name_1 = :v1, #n_user_0.#n_age_2 = :v2');
      expect(result.ExpressionAttributeNames).toEqual({
        '#n_user_0': 'user',
        '#n_name_1': 'name',
        '#n_age_2': 'age',
      });
    });

    it('should handle different value types', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder
        .set('string', 'value')
        .set('number', 42)
        .set('boolean', true)
        .set('null', null)
        .set('object', { key: 'value' })
        .set('array', [1, 2, 3])
        .build();

      expect(result.ExpressionAttributeValues).toEqual({
        ':v1': 'value',
        ':v2': 42,
        ':v3': true,
        ':v4': null,
        ':v5': { key: 'value' },
        ':v6': [1, 2, 3],
      });
    });

    it('should return chained builder instance', () => {
      const builder = new UpdateExpressionBuilder();
      expect(builder.set('field', 'value')).toBe(builder);
      expect(builder.remove('field')).toBe(builder);
    });

    it('should handle empty builder', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder.build();

      expect(result.UpdateExpression).toBe('');
      expect(result.ExpressionAttributeNames).toEqual({});
      expect(result.ExpressionAttributeValues).toEqual({});
    });

    it('should build complex expression with multiple operations', () => {
      const builder = new UpdateExpressionBuilder();
      const result = builder
        .set('user.profile.name', 'John')
        .set('user.profile.email', 'john@example.com')
        .set('status', 'active')
        .remove('deprecatedField')
        .remove('anotherOldField')
        .build();

      expect(result.UpdateExpression).toContain('SET');
      expect(result.UpdateExpression).toContain('REMOVE');
      expect(Object.keys(result.ExpressionAttributeNames).length).toBeGreaterThan(0);
      expect(Object.keys(result.ExpressionAttributeValues).length).toBe(3);
    });
  });
});
