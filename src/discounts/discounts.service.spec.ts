import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscountsService } from './discounts.service.js';
import { DiscountsRepository } from './discounts.repository.js';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DiscountCodeRow } from '../db/rows.js';

describe('DiscountsService', () => {
  let service: DiscountsService;
  let mockRepo: {
    findByCode: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  const createMockRow = (overrides: Partial<DiscountCodeRow> = {}): DiscountCodeRow => ({
    id: '018f0000-0000-7000-8000-000000000001',
    code: 'SAVE10',
    discount_type: 'percent',
    value: '10.00',
    min_order_amount: null,
    max_uses: null,
    uses_count: 0,
    starts_at: null,
    ends_at: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    mockRepo = {
      findByCode: vi.fn(),
      findById: vi.fn(),
      findAll: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    service = new DiscountsService(mockRepo as unknown as DiscountsRepository);
  });

  describe('validate', () => {
    it('returns valid: false when code is empty', async () => {
      const res = await service.validate('', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('required');
    });

    it('returns valid: false when coupon not found', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(null);
      const res = await service.validate('NONEXISTENT', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('Invalid');
    });

    it('returns valid: false when coupon is inactive', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(createMockRow({ is_active: false }));
      const res = await service.validate('SAVE10', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('inactive');
    });

    it('returns valid: false when coupon has expired', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ ends_at: new Date(Date.now() - 10000).toISOString() }),
      );
      const res = await service.validate('SAVE10', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('expired');
    });

    it('returns valid: false when starts_at is in the future', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ starts_at: new Date(Date.now() + 100000).toISOString() }),
      );
      const res = await service.validate('SAVE10', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('not active yet');
    });

    it('returns valid: false when max_uses limit reached', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ max_uses: 10, uses_count: 10 }),
      );
      const res = await service.validate('SAVE10', 100);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('usage limit reached');
    });

    it('returns valid: false when cart total is below min_order_amount', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ min_order_amount: '50.00' }),
      );
      const res = await service.validate('SAVE10', 40);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('minimum order amount');
    });

    it('calculates percentage discount accurately', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ discount_type: 'percent', value: '15.00' }),
      );
      const res = await service.validate('SAVE15', 200);
      expect(res.valid).toBe(true);
      expect(res.discount).toBe(30.0);
    });

    it('calculates fixed discount accurately', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ discount_type: 'fixed', value: '25.00' }),
      );
      const res = await service.validate('FLAT25', 100);
      expect(res.valid).toBe(true);
      expect(res.discount).toBe(25.0);
    });

    it('clamps fixed discount to cart total if discount exceeds cart total', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(
        createMockRow({ discount_type: 'fixed', value: '50.00' }),
      );
      const res = await service.validate('FLAT50', 30);
      expect(res.valid).toBe(true);
      expect(res.discount).toBe(30.0);
    });
  });

  describe('create', () => {
    it('throws BadRequestException if percentage discount exceeds 100', async () => {
      await expect(
        service.create({
          code: 'OVER100',
          discountType: 'percent',
          value: 120,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException if code already exists', async () => {
      mockRepo.findByCode.mockResolvedValueOnce(createMockRow());
      await expect(
        service.create({
          code: 'SAVE10',
          discountType: 'percent',
          value: 10,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates coupon successfully when valid', async () => {
      const mockCreated = createMockRow();
      mockRepo.findByCode.mockResolvedValueOnce(null);
      mockRepo.create.mockResolvedValueOnce(mockCreated);

      const res = await service.create({
        code: 'SAVE10',
        discountType: 'percent',
        value: 10,
      });

      expect(res).toEqual(mockCreated);
      expect(mockRepo.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFoundException if coupon does not exist', async () => {
      mockRepo.findById.mockResolvedValueOnce(null);
      await expect(
        service.update('non-existent-id', { value: 20 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if updated percent exceeds 100', async () => {
      mockRepo.findById.mockResolvedValueOnce(createMockRow());
      await expect(
        service.update('id', { value: 150 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('delete', () => {
    it('throws NotFoundException if coupon to delete not found', async () => {
      mockRepo.delete.mockResolvedValueOnce(false);
      await expect(service.delete('id')).rejects.toThrow(NotFoundException);
    });

    it('deletes successfully when coupon exists', async () => {
      mockRepo.delete.mockResolvedValueOnce(true);
      await expect(service.delete('id')).resolves.toBeUndefined();
    });
  });
});
