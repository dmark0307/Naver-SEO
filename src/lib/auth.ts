export type UserRole = 'ADMIN' | 'USER';

export interface User {
  id: string;
  password?: string; // Optional password for mock auth
  name: string;
  role: UserRole;
  allowedMenus: string[];
  loginAt?: number;
}

export const MOCK_USERS: User[] = [
  {
    id: String(import.meta.env.VITE_ADMIN_ID || 'admin').trim(),
    password: String(import.meta.env.VITE_ADMIN_PASSWORD || '1234').trim(),
    name: '관리자',
    role: 'ADMIN',
    allowedMenus: ['product', 'sales', 'user-management']
  },
  {
    id: 'user',
    password: '1234',
    name: '일반사용자',
    role: 'USER',
    allowedMenus: ['product']
  }
];

export const ALL_MENU_ITEMS = [
  { id: 'product', label: 'SEO 최적화' },
  { id: 'sales', label: '매출 분석' },
  { id: 'user-management', label: '사용자 관리' }
];
