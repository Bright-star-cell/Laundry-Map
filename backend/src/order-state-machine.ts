export const orderStatuses = [
  'CREATED',
  'DRIVER_ASSIGNED_FOR_PICKUP',
  'PICKED_UP',
  'AT_LAUNDROMAT',
  'PROCESSING',
  'READY_FOR_DELIVERY',
  'DRIVER_ASSIGNED_FOR_DROPOFF',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof orderStatuses)[number];

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['DRIVER_ASSIGNED_FOR_PICKUP', 'CANCELLED'],
  DRIVER_ASSIGNED_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['AT_LAUNDROMAT', 'CANCELLED'],
  AT_LAUNDROMAT: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_DELIVERY: ['DRIVER_ASSIGNED_FOR_DROPOFF', 'CANCELLED'],
  DRIVER_ASSIGNED_FOR_DROPOFF: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return transitions[from].includes(to);
}

export function isOrderStatus(value: string): value is OrderStatus {
  return orderStatuses.includes(value as OrderStatus);
}