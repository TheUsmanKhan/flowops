-- Migration 016: Add 'cancelled' to courierBookingStatus CHECK constraint
-- on both Order and exchange_shipments tables.

-- Drop and recreate the CHECK constraint on Order
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_courierBookingStatus_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_courierBookingStatus_check" 
  CHECK ("courierBookingStatus" IN ('not_booked', 'booked', 'failed', 'cancelled'));

-- Drop and recreate the CHECK constraint on exchange_shipments
ALTER TABLE "exchange_shipments" DROP CONSTRAINT IF EXISTS "exchange_shipments_courierBookingStatus_check";
ALTER TABLE "exchange_shipments" ADD CONSTRAINT "exchange_shipments_courierBookingStatus_check" 
  CHECK ("courierBookingStatus" IN ('not_booked', 'booked', 'failed', 'cancelled'));
